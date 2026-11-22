import "./fuzor-source.mjs";
import { spawnSync } from "node:child_process";
import { packageRoot } from "./fuzor-source.mjs";
const result = spawnSync(process.execPath, ["node_modules/fuzor-language-tools/dist/tsc.js", "-p", "tsconfig.json"], { cwd: packageRoot, stdio: "inherit" });
process.exitCode = result.status ?? 1;
