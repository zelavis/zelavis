import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const distributionDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stageDirectory = join(distributionDirectory, ".tmp", "stage");
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

await writeFile(
  join(packageRoot, "DEBIAN", "control"),
  `Package: zelavis\nVersion: ${debianVersion}\nSection: admin\nPriority: optional\nArchitecture: ${architecture}\nMaintainer: Zelavis <support@zelavis.com>\nDepends: ca-certificates\nHomepage: https://zelavis.com\nDescription: Self-hostable Zelavis Platform OS\n Zelavis builds and manages apps, websites, data, content, and server workloads.\n`,
);
await writeFile(
  join(packageRoot, "DEBIAN", "postinst"),
  `#!/bin/sh\nset -e\ngetent group zelavis >/dev/null 2>&1 || groupadd --system zelavis\nid zelavis >/dev/null 2>&1 || useradd --system --gid zelavis --home-dir /var/lib/zelavis --shell /usr/sbin/nologin zelavis\ninstall -d -o zelavis -g zelavis -m 0750 /var/lib/zelavis\nif command -v systemctl >/dev/null 2>&1; then\n  systemctl daemon-reload\n  systemctl enable zelavis.service >/dev/null 2>&1 || true\n  systemctl restart zelavis.service >/dev/null 2>&1 || true\nfi\n`,
  { mode: 0o755 },
);
await writeFile(
  join(packageRoot, "DEBIAN", "prerm"),
  `#!/bin/sh\nset -e\nif [ "${1}" = remove ] && command -v systemctl >/dev/null 2>&1; then\n  systemctl stop zelavis.service >/dev/null 2>&1 || true\n  systemctl disable zelavis.service >/dev/null 2>&1 || true\nfi\n`,
  { mode: 0o755 },
);
await writeFile(
  join(packageRoot, "DEBIAN", "postrm"),
  `#!/bin/sh\nset -e\nif command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload; fi\n`,
  { mode: 0o755 },
);
await chmod(join(packageRoot, "opt", "zelavis", "current", "bin", "zelavis"), 0o755);
execFileSync("dpkg-deb", ["--root-owner-group", "--build", packageRoot, artifact], {
  stdio: "inherit",
});
console.log(`Built ${artifact}`);
