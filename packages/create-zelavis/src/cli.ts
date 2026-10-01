#!/usr/bin/env node
import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { HELP, executeInstallation, installationCommand, installationOverview, loadInstallerAssets, parseArguments, selectInstallMode } from "./index.js";

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) { process.stdout.write(HELP); return; }
  if (parsed.version) {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    console.log(version); return;
  }
  const root = process.getuid?.() === 0;
  const sudo = (process.env.PATH ?? "").split(":").some((path) => { try { accessSync(join(path, "sudo"), constants.X_OK); return true; } catch { return false; } });
  const mode = selectInstallMode(parsed.mode, process.platform, root, sudo);
  const assets = await loadInstallerAssets();
  const command = installationCommand({ ...assets, mode, root, flags: parsed.flags });
  console.log(installationOverview(mode, assets.version));
  console.log(`Exact installation command:\n${command.display}`);
  if (parsed.dryRun) { console.log("No changes were made."); return; }
  if (!parsed.yes) {
    if (!process.stdin.isTTY) throw new Error("Review the plan with --dry-run, then pass --yes to install non-interactively.");
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { if ((await prompt.question("Install on this machine? [y/N] ")).trim().toLowerCase() !== "y") { console.log("Installation cancelled."); return; } }
    finally { prompt.close(); }
  }
  await executeInstallation(command);
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
