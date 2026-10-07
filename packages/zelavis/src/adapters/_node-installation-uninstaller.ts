import { Effect } from "effect";
import { IntegrationFailure, evaluate, integration, present, type TaggedFailure } from "../core/runtime/effect-boundary.js";
import { acquireNodeInstallerLock } from "./_local-ownership.js";
import { preflightZelavisDataMaintenanceProgram } from "../core/runtime/installation-health.js";
import {
  assertCompleteUninstallConfirmation,
  type ZelavisInstallationIdentity,
  type ZelavisInstallationRemovalTarget,
  type ZelavisInstallationUninstaller,
} from "../core/runtime/installation.js";
import {
  assertInstallationPath,
  executeZelavisInstallationPlanProgram,
  planZelavisUninstall,
  readInstallationRoleProgram,
  readNativeInstallationReceiptProgram,
  type ZelavisHostInstallationPlan,
  type ZelavisInstallPaths,
} from "../core/runtime/installation-plan.js";
import { planZelavisWorkerUninstall, readWorkerReceiptProgram } from "../core/runtime/worker-installation-plan.js";
import { assertNodeInstallationPrivilege, createNodeInstallHost, nodeInstallationPaths, nodeUserInstallationPaths } from "./_install-host.js";

export interface NodeInstallationUninstallerOptions {
  readonly installation: ZelavisInstallationIdentity;
  readonly dataDirectory?: string;
  readonly instance?: string;
  /** Explicit host paths for isolated destructive tests. */
  readonly paths?: ZelavisInstallPaths;
  readonly skipHostCommands?: boolean;
}

const refuse = (message: string) => new IntegrationFailure(new Error(message));

/**
 * Complete removal of a packaged installation, a Platform or a worker, chosen
 * by the role its receipt records. The inspected plan is executed directly; no
 * script and no remote route, because removing an installation destroys the
 * authority and the server that would authorize it.
 *
 * It removes only what that role's receipt and inventory name. Each role's
 * planner owns its own inventory; this only resolves, describes and executes.
 */
export function createNodeInstallationUninstaller(options: NodeInstallationUninstallerOptions): ZelavisInstallationUninstaller {
  if (!options.installation.root) {
    throw new TypeError("Complete host uninstall is available only to a packaged Zelavis installation. Use the package manager that installed npm or source copies.");
  }
  const prefix = options.installation.root;
  assertInstallationPath(prefix, "installation root");
  assertInstallationPath(options.installation.path, "CLI entrypoint");
  if (!options.installation.path.startsWith(`${prefix}/`)) throw new Error("The running Zelavis CLI is outside the packaged installation root.");
  const host = createNodeInstallHost();
  const skip = options.skipHostCommands ?? process.env.ZELAVIS_UNINSTALL_SKIP_HOST_COMMANDS === "1";

  interface Resolved {
    readonly role: "platform" | "worker";
    readonly paths: ZelavisInstallPaths;
    readonly plan: ZelavisHostInstallationPlan;
    readonly user: boolean;
  }

  const resolvePlatform = Effect.fn("InstallationUninstall.resolvePlatform")(function* (): Effect.fn.Return<Resolved, TaggedFailure> {
    for (const value of [process.env.ZELAVIS_UNINSTALL_OWNS_USER, process.env.ZELAVIS_UNINSTALL_OWNS_GROUP]) {
      if (value !== undefined && value !== "0" && value !== "1") return yield* refuse("Refusing invalid installer account ownership receipt.");
    }
    const receipt = yield* readNativeInstallationReceiptProgram(host, prefix, options.instance);
    if (!receipt) return yield* refuse("Complete uninstall requires a current installer receipt. npm/source copies without one must use their originating lifecycle.");
    if (options.dataDirectory !== undefined) {
      yield* evaluate(() => assertInstallationPath(options.dataDirectory!, "data directory"));
      if (options.dataDirectory !== receipt.dataDirectory) return yield* refuse("Requested data directory does not match the installer receipt; refusing removal outside its inventory.");
    }
    const user = receipt.mode === "user";
    const base = options.paths ?? (user ? nodeUserInstallationPaths() : nodeInstallationPaths(process.env, options.instance));
    if (user && (prefix !== base.prefix || receipt.dataDirectory !== base.dataDirectory || receipt.commandPath !== base.commandPath || options.dataDirectory !== undefined && options.dataDirectory !== base.dataDirectory)) {
      return yield* refuse("User receipt does not match this user's installation inventory.");
    }
    const paths: ZelavisInstallPaths = {
      ...base,
      prefix,
      instance: receipt.instance,
      configDirectory: receipt.configDirectory,
      dataDirectory: options.dataDirectory ?? receipt.dataDirectory,
      commandPath: receipt.commandPath,
    };
    const listed = yield* integration(() => Promise.resolve(host.listInstances?.(prefix)));
    const otherInstances = (listed ?? []).filter((name) => name !== receipt.instance);
    // Reading each validates it: a malformed neighbour must stop removal, not be skipped.
    yield* Effect.forEach(otherInstances, (name) => readNativeInstallationReceiptProgram(host, prefix, name), { concurrency: 1 });
    const plan = yield* evaluate(() => planZelavisUninstall({
      paths,
      retainShared: otherInstances.length > 0,
      // A Debian install after an archive may leave the archive command link.
      // Retain both in the removal inventory, each checked against this prefix.
      additionalCommandPaths: [base.commandPath],
      user,
      hostCommands: !user && !skip && process.getuid?.() === 0,
      ownsUser: receipt.ownsUser,
      ownsGroup: receipt.ownsGroup,
    }));
    return { role: "platform", paths, plan, user };
  });

  const resolveWorker = Effect.fn("InstallationUninstall.resolveWorker")(function* (): Effect.fn.Return<Resolved, TaggedFailure> {
    const receipt = yield* readWorkerReceiptProgram(host, prefix);
    if (!receipt) return yield* refuse("Complete uninstall requires a current installer receipt.");
    if (options.dataDirectory !== undefined && options.dataDirectory !== receipt.dataDirectory) {
      return yield* refuse("Requested data directory does not match the installer receipt; refusing removal outside its inventory.");
    }
    const base = options.paths ?? nodeInstallationPaths(process.env);
    const paths: ZelavisInstallPaths = { ...base, prefix, configDirectory: receipt.dataDirectory, dataDirectory: receipt.dataDirectory, commandPath: receipt.commandPath };
    const plan = yield* evaluate(() => planZelavisWorkerUninstall({ paths, receipt, hostCommands: !skip && process.getuid?.() === 0 }));
    return { role: "worker", paths, plan, user: false };
  });

  const resolve = Effect.fn("InstallationUninstall.resolve")(function* (): Effect.fn.Return<Resolved, TaggedFailure> {
    const role = yield* readInstallationRoleProgram(host, prefix, options.instance);
    if (role === undefined) return yield* refuse("Complete uninstall requires a current installer receipt. npm/source copies without one must use their originating lifecycle.");
    return role === "worker" ? yield* resolveWorker() : yield* resolvePlatform();
  });

  const describe = Effect.fn("InstallationUninstall.describe")(function* (plan: ZelavisHostInstallationPlan) {
    const targets = yield* Effect.forEach(plan.steps, (step) => Effect.gen(function* () {
      const action = step.action;
      const path = "path" in action ? action.path : undefined;
      const target: ZelavisInstallationRemovalTarget = {
        id: action.kind === "remove" && path === plan.dataDirectory ? "data" : step.id,
        kind: action.kind === "remove-link" ? "command" : action.kind === "purge-packages" ? "package" : action.kind === "remove-account" ? "account" : action.kind === "remove" ? "directory" : "service",
        description: step.description,
        ...(path ? { path, exists: yield* integration(() => host.exists(path)) } : {}),
      };
      return target;
    }), { concurrency: 4 });
    return { adapter: "node", installation: options.installation, dataDirectory: plan.dataDirectory, targets, retained: plan.retained, steps: plan.steps };
  });

  return {
    plan: () => present(Effect.gen(function* () {
      return yield* describe((yield* resolve()).plan);
    })),
    uninstall: (input) => present(Effect.scoped(Effect.gen(function* () {
      yield* evaluate(() => assertCompleteUninstallConfirmation(input.confirmation));
      const initial = yield* resolve();
      yield* integration(() => assertNodeInstallationPrivilege(initial.paths, skip || initial.user));
      yield* Effect.acquireRelease(integration(() => acquireNodeInstallerLock(prefix)), (lock) => integration(() => lock.release()).pipe(Effect.orDie));
      // Resolved again under the lock: what was inspected is what is removed.
      const { role, paths, plan, user } = yield* resolve();
      if (role === "platform") yield* preflightZelavisDataMaintenanceProgram({ host, paths, system: !user && !skip });
      const described = yield* describe(plan);
      const output = yield* executeZelavisInstallationPlanProgram(host, plan, input.confirmation);
      return {
        removed: true as const,
        plan: described,
        output: [...output, role === "worker" ? "Zelavis worker, its configuration and data removed." : "Zelavis installation, configuration and data removed."].join("\n"),
      };
    }))),
  };
}
