import { createNodeInstallHost, nodeInstallationPaths, nodeUserInstallationPaths } from "../../adapters/_install-host.js";
import { inspectZelavisInstallation } from "../../core/runtime/installation-health.js";
import { describeInstallation } from "../installation.js";

export async function runInstallationDoctor(args: readonly string[], cliPath: string): Promise<void> {
  let user = false, system = false, json = false;
  for (const arg of args) {
    if (arg === "--user") user = true;
    else if (arg === "--system") system = true;
    else if (arg === "--json") json = true;
    else throw new Error(`Unknown doctor option: ${arg}`);
  }
  if (user && system) throw new Error("Choose --user or --system.");
  const installation = describeInstallation(cliPath);
  const userPaths = nodeUserInstallationPaths();
  const paths = user || !system && installation.root === userPaths.prefix ? userPaths : nodeInstallationPaths();
  const report = await inspectZelavisInstallation({ host: createNodeInstallHost(), paths, installation });
  console.log(json ? JSON.stringify(report, null, 2) : [`Zelavis doctor: ${installation.kind} at ${installation.root ?? installation.path}`, ...report.checks.map((check) => `${check.status.toUpperCase()} ${check.id}: ${check.detail}`)].join("\n"));
  if (!report.healthy) process.exitCode = 1;
}
