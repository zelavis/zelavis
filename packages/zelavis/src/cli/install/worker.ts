import { Effect, Scope } from "effect";
import { integration, IntegrationFailure, type TaggedFailure } from "../../core/runtime/effect-boundary.js";
import { executeZelavisInstallationPlanProgram } from "../../core/runtime/installation-plan.js";
import { planZelavisWorkerInstallProgram, WORKER_ACCOUNT, validateWorkerInstallPaths } from "../../core/runtime/worker-installation-plan.js";
import { acquireNodeInstallerLock } from "../../adapters/_local-ownership.js";
import { assertNodeInstallationPrivilege, createNodeInstallHost, nodeWorkerInstallationPaths } from "../../adapters/_install-host.js";
import { assembleNpmReleaseTreeProgram } from "../../adapters/_release-tree.js";

/** The flags `zelavis install --role worker` accepts, already parsed. */
export interface WorkerInstallOptions {
  readonly source: string | undefined;
  readonly npmPrepared: string | undefined;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly force: boolean;
  readonly allowDowngrade: boolean;
  readonly installedBy: "script" | "create" | "cli";
  readonly invokingPath: string | undefined;
  /** Platform-only flags that were given, so a worker can refuse them by name. */
  readonly platformOnly: readonly string[];
}

/**
 * Installs the worker role: the release tree, one dedicated account and one
 * unit that runs the Agent once the machine has joined a Platform.
 *
 * Linux with systemd and root only. A worker is a server role, not a developer
 * convenience, so there is no user mode and no named instance; the flags that
 * only mean something to a Platform are refused by name instead of ignored.
 */
export const runWorkerInstallProgram = Effect.fn("InstallationCLI.runWorkerInstall")(function* (options: WorkerInstallOptions): Effect.fn.Return<void, TaggedFailure, Scope.Scope> {
  const refuse = (message: string) => new IntegrationFailure(new Error(message));
  if (options.platformOnly.length > 0) {
    return yield* refuse(`${options.platformOnly.join(", ")} only applies to a Platform; a worker has no ${options.platformOnly.includes("--port") ? "dashboard port" : "such setting"}.`);
  }
  if (options.source && options.npmPrepared) return yield* refuse("Choose either --from-release <path> or --from-npm <path>.");
  if (!options.source && !options.npmPrepared) return yield* refuse("zelavis install requires --from-release <absolute staged-release path> or --from-npm <absolute prepared path>.");
  const host = createNodeInstallHost({ ...(options.invokingPath ? { invokingPath: options.invokingPath } : {}) });
  const paths = nodeWorkerInstallationPaths(process.env);
  yield* Effect.try({ try: () => validateWorkerInstallPaths(paths), catch: (error) => new IntegrationFailure(error) });
  const systemd = !!(yield* integration(() => host.which("systemctl")));
  const isolated = paths.prefix !== "/opt/zelavis";
  if (!isolated) {
    if (process.platform !== "linux") return yield* refuse("A worker requires Linux with systemd.");
    if (!options.dryRun && process.getuid?.() !== 0) return yield* refuse("Installing a worker must run as root.");
    if (!options.dryRun && !systemd) return yield* refuse("A worker requires systemd.");
  }
  if (!options.dryRun) {
    yield* integration(() => assertNodeInstallationPrivilege({ ...paths, configDirectory: paths.dataDirectory, systemdDirectories: paths.systemdDirectories }));
    yield* Effect.acquireRelease(integration(() => acquireNodeInstallerLock(paths.prefix)), (lock) => integration(() => lock.release()).pipe(Effect.orDie));
  }
  const source = options.npmPrepared ? (yield* assembleNpmReleaseTreeProgram(options.npmPrepared), options.npmPrepared) : options.source!;
  const plan = yield* planZelavisWorkerInstallProgram({
    host, source, paths, force: options.force, allowDowngrade: options.allowDowngrade, installedBy: options.installedBy,
  });
  if (options.dryRun) {
    console.log(options.json ? JSON.stringify(plan, null, 2)
      : ["Zelavis worker install plan", ...plan.steps.map((step) => `  ${step.id}: ${step.description} (idempotent: ${step.idempotent})`), ...plan.warnings, "No changes were made."].join("\n"));
    return;
  }
  for (const warning of plan.warnings) console.error(warning);
  const output = yield* executeZelavisInstallationPlanProgram(host, plan);
  const join = `sudo -u ${WORKER_ACCOUNT} ${paths.commandPath} worker join --data-dir ${paths.dataDirectory} ` +
    "--platform-url https://<platform-host> --node-id <node-id> --enrollment-token <token>";
  if (options.json) console.log(JSON.stringify({ installed: true, role: "worker", plan, output, join }, null, 2));
  else {
    console.log([
      "Zelavis worker installed. It is not part of a Platform yet.",
      "Issue an enrollment on the Platform (`zelavis nodes enroll-token <node-id>`), then join as the worker's own account:",
      `  ${join}`,
      "The worker Agent starts by itself once it has joined. It listens on port 8443: allow the Platform to reach it.",
      ...output,
    ].join("\n"));
  }
});
