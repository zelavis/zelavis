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
// dpkg owns only the incoming payload. Installer-owned immutable releases must
// survive package upgrades while another instance still selects an older version.
const releaseDirectory = join(packageRoot, "opt", "zelavis", "package");
await mkdir(dirname(releaseDirectory), { recursive: true });
await cp(stageDirectory, releaseDirectory, { recursive: true });
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
for (const unit of ["zelavis@.service", "zelavis-agent@.service"]) {
  await cp(join(stageDirectory, "share", unit), join(packageRoot, "lib", "systemd", "system", unit));
}
await mkdir(join(packageRoot, "etc", "zelavis"), { recursive: true });
await mkdir(join(packageRoot, "etc", "zelavis", "edge", "traefik"), { recursive: true });
await cp(
  join(stageDirectory, "share", "traefik.yml"),
  join(packageRoot, "etc", "zelavis", "edge", "traefik", "traefik.yml"),
);

await writeFile(
  join(packageRoot, "DEBIAN", "control"),
  `Package: zelavis\nVersion: ${debianVersion}\nSection: admin\nPriority: optional\nArchitecture: ${architecture}\nMaintainer: Zelavis <support@zelavis.com>\nDepends: ca-certificates, tar, util-linux\nHomepage: https://zelavis.com\nDescription: Self-hostable Zelavis Platform OS\n Zelavis builds and manages apps, websites, data, content, and server workloads.\n`,
);
// The Edge configuration is operator configuration: dpkg keeps local edits
// across upgrades instead of overwriting them.
await writeFile(
  join(packageRoot, "DEBIAN", "conffiles"),
  "/etc/zelavis/edge/traefik/traefik.yml\n",
);
await writeFile(
  join(packageRoot, "DEBIAN", "postinst"),
  `#!/bin/sh
set -e
ZELAVIS_BIN_DIR=/usr/bin exec /opt/zelavis/package/runtime/node/bin/node /opt/zelavis/package/platform/dist/cli.js install --from-release /opt/zelavis/package --installed-by deb
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
await chmod(join(packageRoot, "opt", "zelavis", "package", "bin", "zelavis"), 0o755);
if (!options.prepareOnly) {
  execFileSync("dpkg-deb", ["--root-owner-group", "--build", packageRoot, artifact], {
    stdio: "inherit",
  });
  console.log(`Built ${artifact}`);
} else {
  console.log(`Prepared Debian package tree at ${packageRoot}`);
}
