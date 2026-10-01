// Records which Zelavis release this create package installs. It is the version
// of the `zelavis` package in this repository at build time, so a project made
// by a published create package gets exactly the release published with it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const platform = JSON.parse(readFileSync(join(here, "../../zelavis/package.json"), "utf8"));
const out = join(here, "../dist");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "versions.json"), `${JSON.stringify({ zelavis: platform.version, node: platform.engines?.node ?? ">=24" }, null, 2)}\n`);
console.log(`Stamped zelavis ${platform.version}.`);
