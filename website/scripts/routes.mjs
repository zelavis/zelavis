import { spawnSync } from "node:child_process";
import { packageRoot } from "./fuzor-source.mjs";

const result = spawnSync(
  process.execPath,
  ["node_modules/fuzor/dist/cli.js", "routes", "--target", "mpa", ...process.argv.slice(2)],
  { cwd: packageRoot, stdio: "inherit" },
);

process.exitCode = result.status ?? 1;
