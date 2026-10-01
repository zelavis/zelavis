// Distribution owns these sources. Publish them with the Platform without
// maintaining a second template or checksum implementation.
import { copyFile, mkdir } from "node:fs/promises";
const output = new URL("../dist/installation-assets/", import.meta.url);
const distribution = new URL("../../../distribution/", import.meta.url);
await mkdir(output, { recursive: true });
await copyFile(new URL("scripts/runtime-assets.mjs", distribution), new URL("runtime-assets.mjs", output));
await copyFile(new URL("release.json", distribution), new URL("release.json", output));
