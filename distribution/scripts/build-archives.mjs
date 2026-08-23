import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const distributionDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stageDirectory = join(distributionDirectory, ".tmp", "stage");
const artifactsDirectory = join(distributionDirectory, "artifacts");

const manifest = JSON.parse(await readFile(join(stageDirectory, "manifest.json"), "utf8"));
const releaseName = `zelavis-${manifest.version}-${manifest.platform}-${manifest.architecture}`;
const archiveRoot = join(distributionDirectory, ".tmp", releaseName);

await mkdir(artifactsDirectory, { recursive: true });
await rm(archiveRoot, { recursive: true, force: true });
execFileSync("cp", ["-R", stageDirectory, archiveRoot]);
execFileSync("tar", ["-czf", join(artifactsDirectory, `${releaseName}.tar.gz`), "-C", dirname(archiveRoot), basename(archiveRoot)]);
execFileSync("zip", ["-qry", join(artifactsDirectory, `${releaseName}.zip`), basename(archiveRoot)], {
  cwd: dirname(archiveRoot),
});
console.log(`Built ${releaseName}.tar.gz and ${releaseName}.zip`);
