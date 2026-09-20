import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const distributionDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(args) {
  const options = {
    stage: join(distributionDirectory, ".tmp", "stage"),
    prepareOnly: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--stage") {
      options.stage = resolve(args[index + 1]);
      index += 1;
    } else if (arg === "--prepare-only") {
      options.prepareOnly = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const stageDirectory = options.stage;
const artifactsDirectory = join(distributionDirectory, "artifacts");
const packageRoot = join(distributionDirectory, ".tmp", "deb-root");
const manifest = JSON.parse(await readFile(join(stageDirectory, "manifest.json"), "utf8"));

if (manifest.platform !== "linux") {
  throw new Error("Debian packages must be built from a Linux staging tree.");
}

const architecture = { x64: "amd64", arm64: "arm64" }[manifest.architecture];
if (!architecture) throw new Error(`Unsupported Debian architecture: ${manifest.architecture}`);
const debianVersion = manifest.version.replace(/-([0-9A-Za-z])/g, "~$1");
const artifact = join(artifactsDirectory, `zelavis_${debianVersion}_${architecture}.deb`);

await rm(packageRoot, { recursive: true, force: true });
await mkdir(join(packageRoot, "DEBIAN"), { recursive: true });
await mkdir(join(packageRoot, "opt", "zelavis"), { recursive: true });
await mkdir(join(packageRoot, "usr", "bin"), { recursive: true });
await mkdir(join(packageRoot, "lib", "systemd", "system"), { recursive: true });
await mkdir(artifactsDirectory, { recursive: true });
await cp(stageDirectory, join(packageRoot, "opt", "zelavis", "current"), { recursive: true });
await symlink("/opt/zelavis/current/bin/zelavis", join(packageRoot, "usr", "bin", "zelavis"));
await cp(
  join(stageDirectory, "share", "zelavis.service"),
  join(packageRoot, "lib", "systemd", "system", "zelavis.service"),
);
// Installed but not enabled: running Projects through the Agent is opted into
// with `systemctl enable --now zelavis-agent` and a zelavis.service drop-in
// setting ZELAVIS_AGENT_ENDPOINT=/var/lib/zelavis/agent.
await cp(
  join(stageDirectory, "share", "zelavis-agent.service"),
  join(packageRoot, "lib", "systemd", "system", "zelavis-agent.service"),
);
await cp(
  join(stageDirectory, "share", "zelavis-traefik.service"),
  join(packageRoot, "lib", "systemd", "system", "zelavis-traefik.service"),
);
await mkdir(join(packageRoot, "etc", "zelavis"), { recursive: true });
await mkdir(join(packageRoot, "etc", "zelavis", "edge", "traefik"), { recursive: true });
await cp(
  join(stageDirectory, "share", "traefik.yml"),
  join(packageRoot, "etc", "zelavis", "edge", "traefik", "traefik.yml"),
);
await cp(
  join(stageDirectory, "share", "operation-trust.json"),
  join(packageRoot, "etc", "zelavis", "operation-trust.json"),
);
await chmod(join(packageRoot, "etc", "zelavis", "operation-trust.json"), 0o644);

await writeFile(
  join(packageRoot, "DEBIAN", "control"),
  `Package: zelavis\nVersion: ${debianVersion}\nSection: admin\nPriority: optional\nArchitecture: ${architecture}\nMaintainer: Zelavis <support@zelavis.com>\nDepends: ca-certificates, nginx, php-fpm, php-cli, php-mysql, php-curl, php-gd, php-intl, php-mbstring, php-xml, php-zip, mariadb-server-core, mariadb-client-core, tar\nHomepage: https://zelavis.com\nDescription: Self-hostable Zelavis Platform OS\n Zelavis builds and manages apps, websites, data, content, and server workloads.\n`,
);
// The trust store is operator configuration: dpkg keeps local edits (added or
// revoked keys) across upgrades instead of overwriting them.
await writeFile(
  join(packageRoot, "DEBIAN", "conffiles"),
  "/etc/zelavis/operation-trust.json\n/etc/zelavis/edge/traefik/traefik.yml\n",
);
await writeFile(
  join(packageRoot, "DEBIAN", "postinst"),
  `#!/bin/sh
set -e
OWNS_GROUP=0
OWNS_USER=0
if ! getent group zelavis >/dev/null 2>&1; then
  groupadd --system zelavis
  OWNS_GROUP=1
fi
if ! id zelavis >/dev/null 2>&1; then
  useradd --system --gid zelavis --home-dir /var/lib/zelavis --shell /usr/sbin/nologin zelavis
  OWNS_USER=1
fi
install -d -o zelavis -g zelavis -m 0750 /var/lib/zelavis
install -d -o zelavis -g zelavis -m 0750 /var/lib/zelavis/edge/traefik/active

GENERATED_BOOTSTRAP_TOKEN=
if [ ! -f /etc/zelavis/zelavis.env ]; then
  install -d -m 0755 /etc/zelavis
  GENERATED_BOOTSTRAP_TOKEN=$(/opt/zelavis/current/runtime/node/bin/node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')
  umask 077
  printf 'ZELAVIS_BOOTSTRAP_TOKEN=%s\n' "$GENERATED_BOOTSTRAP_TOKEN" > /etc/zelavis/zelavis.env
fi

RECEIPT=/opt/zelavis/installation.json
RECEIPT_TMP=/opt/zelavis/.installation.json.$$
/opt/zelavis/current/runtime/node/bin/node -e '
  const fs = require("node:fs");
  const [, output, current, createdUser, createdGroup] = process.argv;
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(current, "utf8")); } catch {}
  const receipt = {
    schemaVersion: 1,
    dataDirectory: "/var/lib/zelavis",
    commandPath: "/usr/bin/zelavis",
    ownsUser: previous.ownsUser === true || createdUser === "1",
    ownsGroup: previous.ownsGroup === true || createdGroup === "1",
  };
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + String.fromCharCode(10), { mode: 0o600 });
' "$RECEIPT_TMP" "$RECEIPT" "$OWNS_USER" "$OWNS_GROUP"
mv -f "$RECEIPT_TMP" "$RECEIPT"

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  systemctl enable zelavis.service >/dev/null 2>&1 || true
  systemctl restart zelavis.service >/dev/null 2>&1 || true
  # The unit and verified binary are installed, but Edge does not start the
  # listener until it can stage, probe, and roll back a complete publication.
  systemctl disable zelavis-traefik.service >/dev/null 2>&1 || true
fi

RESOLVED=$(command -v zelavis 2>/dev/null || true)
if [ -n "$RESOLVED" ] && [ "$RESOLVED" != /usr/bin/zelavis ]; then
  echo "Warning: 'zelavis' on PATH resolves to $RESOLVED, not /usr/bin/zelavis." >&2
  echo "  That installation answers instead of this package; it is usually a global npm install." >&2
  echo "  Run 'zelavis --version' to see which one is in use." >&2
fi
if [ -n "$GENERATED_BOOTSTRAP_TOKEN" ]; then
  echo "First-run bootstrap token: $GENERATED_BOOTSTRAP_TOKEN"
  echo "Enter it in the dashboard setup wizard or run: zelavis setup"
fi
`,
  { mode: 0o755 },
);
await writeFile(
  join(packageRoot, "DEBIAN", "prerm"),
  `#!/bin/sh\nset -e\nif [ "${1}" = remove ] && command -v systemctl >/dev/null 2>&1; then\n  systemctl stop zelavis.service zelavis-traefik.service >/dev/null 2>&1 || true\n  systemctl disable zelavis.service zelavis-traefik.service >/dev/null 2>&1 || true\nfi\n`,
  { mode: 0o755 },
);
await writeFile(
  join(packageRoot, "DEBIAN", "postrm"),
  `#!/bin/sh\nset -e\nif command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload; fi\n`,
  { mode: 0o755 },
);
await chmod(join(packageRoot, "opt", "zelavis", "current", "bin", "zelavis"), 0o755);
if (!options.prepareOnly) {
  execFileSync("dpkg-deb", ["--root-owner-group", "--build", packageRoot, artifact], {
    stdio: "inherit",
  });
  console.log(`Built ${artifact}`);
} else {
  console.log(`Prepared Debian package tree at ${packageRoot}`);
}
