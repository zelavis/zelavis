import { writeChecksums } from "./checksums.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const distributionDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDirectory = join(distributionDirectory, "artifacts");
console.log(`Wrote checksums for ${await writeChecksums(artifactsDirectory)} artifact(s).`);
