import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const distributionDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDirectory = join(distributionDirectory, "artifacts");
const names = (await readdir(artifactsDirectory))
  .filter((name) => /\.(deb|tar\.gz|zip)$/.test(name))
  .sort();

const lines = [];
for (const name of names) {
  const digest = createHash("sha256")
    .update(await readFile(join(artifactsDirectory, name)))
    .digest("hex");
  lines.push(`${digest}  ${name}`);
}
await writeFile(join(artifactsDirectory, "SHA256SUMS"), `${lines.join("\n")}\n`);
console.log(`Wrote checksums for ${names.length} artifact(s).`);
