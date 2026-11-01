import { Effect } from "effect";
import { present, integrationValue, type IntegrationFailure } from "../../core/runtime/effect-boundary.js";
import { createNodeInstallHost, nodeInstallationPaths, nodeUserInstallationPaths } from "../../adapters/_install-host.js";
import { inspectZelavisInstallation } from "../../core/runtime/installation-health.js";
import { readInstallationRole } from "../../core/runtime/installation-plan.js";
import { inspectZelavisWorker, readWorkerReceipt } from "../../core/runtime/worker-installation-plan.js";
import { describeInstallation } from "../installation.js";

export function runInstallationDoctor(args: readonly string[], cliPath: string): Promise<void> {
    return present(Effect.gen(function* (): Effect.fn.Return<void, IntegrationFailure> {
  let user = false, system = false, json = false;
  let instance = "default";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--instance") { instance = args[++i]; if (!instance) throw new Error("--instance requires a value."); }
    else if (arg === "--user") user = true;
    else if (arg === "--system") system = true;
    else if (arg === "--json") json = true;
    else throw new Error(`Unknown doctor option: ${arg}`);
  }
  if (user && instance !== "default") throw new Error("Named instances require system mode.");
  if (user && system) throw new Error("Choose --user or --system.");
  const installation = describeInstallation(cliPath);
  const userPaths = nodeUserInstallationPaths();
  const paths = user || !system && installation.root === userPaths.prefix ? userPaths : nodeInstallationPaths(process.env, instance);
  if (instance !== "default" && paths.prefix === userPaths.prefix) throw new Error("Named instances require system mode.");
  const host = createNodeInstallHost();
  // A machine is a Platform or a worker; the receipt says which, so doctor inspects the right one.
  const role = !user && instance === "default" ? (yield* integrationValue(readInstallationRole(host, paths.prefix))) : undefined;
  const report = role === "worker"
    ? yield* Effect.gen(function* () {
      const receipt = yield* integrationValue(readWorkerReceipt(host, paths.prefix));
      if (!receipt) throw new Error("No worker installation receipt.");
      return yield* integrationValue(inspectZelavisWorker({ host, installation,
        paths: { ...paths, configDirectory: receipt.dataDirectory, dataDirectory: receipt.dataDirectory, commandPath: receipt.commandPath } }));
    })
    : (yield* integrationValue(inspectZelavisInstallation({ host, paths, installation })));
  console.log(json ? JSON.stringify(report, null, 2) : [`Zelavis doctor: ${installation.kind} at ${installation.root ?? installation.path}`, ...report.checks.map((check) => `${check.status.toUpperCase()} ${check.id}: ${check.detail}`)].join("\n"));
  if (!report.healthy) process.exitCode = 1;
}));
  }
