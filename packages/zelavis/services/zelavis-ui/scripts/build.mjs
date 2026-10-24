import { gridNotices, writeGridNotices } from "./grid-licenses.mjs";
gridNotices();
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { packageRoot, writeFuzorProvenance } from "./fuzor-source.mjs";
// A release ships exactly this build: Fuzor keeps earlier assets so open pages survive a deploy, and those must not ride along.
for (const output of [".fuzor/web", ".fuzor/dist-backend", ".fuzor/dist-spa-server"]) rmSync(resolve(packageRoot, output), { recursive: true, force: true });
const styles = spawnSync(process.execPath, ["scripts/generate-service-page-styles.mjs"], { cwd: packageRoot, stdio: "inherit" });
if (styles.status !== 0) process.exit(styles.status ?? 1);
const result = spawnSync(process.execPath, ["node_modules/fuzor/dist/cli.js", "build", "--target", "spa"], { cwd: packageRoot, stdio: "inherit" });
process.exitCode = result.status ?? 1;

if (result.status === 0) {
  const runtime = spawnSync(process.execPath, ["scripts/build-service-ui.mjs"], { cwd: packageRoot, stdio: "inherit" });
  if (runtime.status !== 0) process.exit(runtime.status ?? 1);
}
if (result.status === 0) { writeGridNotices(); writeFuzorProvenance(); }

// The shipped server entry may import only `effect` (the Platform provides it) and Node itself. Anything else would
// have to be installed beside the dashboard, which an installation never does; a Fuzor that predates
// `serverExternal` (before 0.5.1) leaves `fuzor/*` imports in, so refuse it here rather than at runtime.
if (result.status === 0) {
  const entry = readFileSync(resolve(packageRoot, ".fuzor/dist-backend/entry.mjs"), "utf8");
  const imported = [...entry.matchAll(/^(?:import|export)\b[^;\n]*?\bfrom\s*["']([^"'.][^"']*)["']/gm)].map(match => match[1]);
  const foreign = imported.filter(name => !name.startsWith("node:") && !/^effect(\/|$)/.test(name));
  if (foreign.length) { console.error(`The dashboard server bundle imports ${[...new Set(foreign)].join(", ")}, which an installation does not provide. Build with Fuzor 0.5.1 or newer.`); process.exitCode = 1; }
}
