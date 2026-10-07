import "./link-local.mjs";
import { spawnSync } from "node:child_process";
import { packageRoot } from "./link-local.mjs";
const result = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit"], { cwd: packageRoot, stdio: "inherit" });
process.exitCode = result.status ?? 1;
