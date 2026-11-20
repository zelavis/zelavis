import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { packageRoot, syncInstallScript, writeFuzorProvenance } from "./fuzor-source.mjs";

syncInstallScript();
rmSync(resolve(packageRoot, "dist"), { recursive: true, force: true });
rmSync(resolve(packageRoot, ".fuzor/web"), { recursive: true, force: true });

const result = spawnSync(
  process.execPath,
  ["node_modules/fuzor/dist/cli.js", "build", "--target", "mpa", "--deployment", "static"],
  { cwd: packageRoot, stdio: "inherit" },
);

if (result.status === 0) {
  writeFuzorProvenance();
}

process.exitCode = result.status ?? 1;
