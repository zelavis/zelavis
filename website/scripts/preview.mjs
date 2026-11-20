import { spawn } from "node:child_process";
import { packageRoot } from "./fuzor-source.mjs";

const child = spawn(
  process.execPath,
  ["node_modules/fuzor/dist/cli.js", "preview", "--target", "mpa", ...process.argv.slice(2)],
  { cwd: packageRoot, stdio: "inherit" },
);

process.once("SIGINT", () => child.kill("SIGINT"));
process.once("SIGTERM", () => child.kill("SIGTERM"));
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
