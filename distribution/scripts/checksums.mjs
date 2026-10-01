import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function fileChecksum(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function writeChecksums(directory) {
  const names = (await readdir(directory)).filter((name) => /\.(deb|tar\.gz|zip)$/.test(name)).sort();
  const lines = [];
  for (const name of names) lines.push(`${await fileChecksum(join(directory, name))}  ${name}`);
  await writeFile(join(directory, "SHA256SUMS"), `${lines.join("\n")}\n`);
  return names.length;
}
