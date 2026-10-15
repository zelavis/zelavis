// The Fuzor dev server for the dashboard, on the freshest Fuzor (see fuzor-source.mjs). The root `pnpm dev` runs this
// beside a Platform; the flags are Fuzor's own (`--host`, `--port`).
import { spawn } from "node:child_process";
import { packageRoot } from "./fuzor-source.mjs";

const child = spawn(process.execPath, ["node_modules/fuzor/dist/cli.js", "dev", "--target", "spa", ...process.argv.slice(2)], {
  cwd: packageRoot,
  stdio: "inherit",
  env: { ...process.env, ZELAVIS_UI_BASE_PATH: process.env.ZELAVIS_UI_BASE_PATH ?? "/zelavis/" },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
