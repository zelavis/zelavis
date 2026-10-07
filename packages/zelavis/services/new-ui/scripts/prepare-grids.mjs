import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const result = spawnSync("npm", ["ci", "--prefix", "grid-dependencies", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
await import("./link-local.mjs");
