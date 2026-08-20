import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const distributionDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDirectory = join(distributionDirectory, "artifacts");
const repositoryDirectory = join(artifactsDirectory, "apt");
const packageRoot = join(distributionDirectory, ".tmp", "repository-deb-root");
const releaseConfig = JSON.parse(
  await readFile(join(distributionDirectory, "release.json"), "utf8"),
);
const version = releaseConfig.repositoryPackageVersion ?? "1.0.0";
const artifact = join(artifactsDirectory, `zelavis-repository_${version}_all.deb`);

if (process.platform !== "linux") {
  throw new Error("The repository bootstrap package must be built on Linux.");
}

await rm(packageRoot, { recursive: true, force: true });
await mkdir(join(packageRoot, "DEBIAN"), { recursive: true });
await mkdir(join(packageRoot, "etc", "apt", "sources.list.d"), { recursive: true });
await mkdir(join(packageRoot, "usr", "share", "keyrings"), { recursive: true });
await copyFile(
  join(distributionDirectory, "apt", "zelavis.sources"),
  join(packageRoot, "etc", "apt", "sources.list.d", "zelavis.sources"),
);
await copyFile(
  join(repositoryDirectory, "zelavis-archive-keyring.gpg"),
  join(packageRoot, "usr", "share", "keyrings", "zelavis-archive-keyring.gpg"),
);
await writeFile(
  join(packageRoot, "DEBIAN", "control"),
  `Package: zelavis-repository\nVersion: ${version}\nSection: admin\nPriority: optional\nArchitecture: all\nMaintainer: Zelavis <support@zelavis.com>\nDepends: ca-certificates\nHomepage: https://zelavis.com\nDescription: Zelavis APT repository configuration\n Installs the signed Zelavis package source and release key.\n`,
);
execFileSync("dpkg-deb", ["--root-owner-group", "--build", packageRoot, artifact], {
  stdio: "inherit",
});
console.log(`Built ${artifact}`);
