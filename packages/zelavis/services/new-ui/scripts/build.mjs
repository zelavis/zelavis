import { gridNotices, writeGridNotices } from "./grid-licenses.mjs";
gridNotices();
import "./link-local.mjs";
import { spawnSync } from "node:child_process";
import { packageRoot } from "./link-local.mjs";
import { ensureFuzorBuilt, writeFuzorProvenance } from "./fuzor-source.mjs";
ensureFuzorBuilt();
const audit = spawnSync(process.execPath, ["scripts/audit-routes.mjs", "--check"], { cwd: packageRoot, stdio: "inherit" });
if (audit.status !== 0) process.exit(audit.status ?? 1);
const result = spawnSync(process.execPath, ["node_modules/fuzor/dist/cli.js", "build", "--target", "spa"], { cwd: packageRoot, stdio: "inherit" });
process.exitCode = result.status ?? 1;

if (result.status === 0) { writeGridNotices(); writeFuzorProvenance(); }
