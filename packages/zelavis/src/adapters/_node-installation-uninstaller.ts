import {
  assertCompleteUninstallConfirmation,
  type ZelavisInstallationIdentity,
  type ZelavisInstallationRemovalTarget,
  type ZelavisInstallationUninstaller,
} from "../core/runtime/installation.js";
import {
  assertInstallationPath,
  executeZelavisInstallationPlan,
  planZelavisUninstall,
  readNativeInstallationReceipt,
  type ZelavisInstallPaths,
} from "../core/runtime/installation-plan.js";
import { assertNodeInstallationPrivilege, createNodeInstallHost, nodeInstallationPaths } from "./_install-host.js";

export interface NodeInstallationUninstallerOptions {
  readonly installation: ZelavisInstallationIdentity;
  readonly dataDirectory?: string;
  /** Explicit host paths for isolated destructive tests. */
  readonly paths?: ZelavisInstallPaths;
  readonly skipHostCommands?: boolean;
}

/** Executes the inspected TypeScript plan directly; no script or remote route. */
export function createNodeInstallationUninstaller(options: NodeInstallationUninstallerOptions): ZelavisInstallationUninstaller {
  if (options.installation.kind !== "packaged" || !options.installation.root) {
    throw new TypeError("Complete host uninstall is available only to a packaged Zelavis installation. Use the package manager that installed npm or source copies.");
  }
  const prefix = options.installation.root;
  assertInstallationPath(prefix, "installation root");
  assertInstallationPath(options.installation.path, "CLI entrypoint");
  if (!options.installation.path.startsWith(`${prefix}/`)) throw new Error("The running Zelavis CLI is outside the packaged installation root.");
  const host = createNodeInstallHost();
  const skip = options.skipHostCommands ?? process.env.ZELAVIS_UNINSTALL_SKIP_HOST_COMMANDS === "1";
  const resolvePlan = async () => {
    for (const value of [process.env.ZELAVIS_UNINSTALL_OWNS_USER, process.env.ZELAVIS_UNINSTALL_OWNS_GROUP]) {
      if (value !== undefined && value !== "0" && value !== "1") throw new Error("Refusing invalid installer account ownership receipt.");
    }
    const receipt = await readNativeInstallationReceipt(host, prefix);
    const base = options.paths ?? nodeInstallationPaths();
    const paths = {
      ...base,
      prefix,
      dataDirectory: options.dataDirectory ?? receipt?.dataDirectory ?? base.dataDirectory,
      commandPath: receipt?.commandPath ?? base.commandPath,
    };
    const plan = planZelavisUninstall({
      paths,
      // A Debian install after an archive may leave the archive command link.
      // Retain both in the removal inventory, each checked against this prefix.
      additionalCommandPaths: [base.commandPath],
      hostCommands: !skip && process.getuid?.() === 0,
      ownsUser: receipt?.ownsUser ?? process.env.ZELAVIS_UNINSTALL_OWNS_USER === "1",
      ownsGroup: receipt?.ownsGroup ?? process.env.ZELAVIS_UNINSTALL_OWNS_GROUP === "1",
    });
    return { paths, plan };
  };
  const describe = async (plan: Awaited<ReturnType<typeof resolvePlan>>["plan"]) => {
    const targets: ZelavisInstallationRemovalTarget[] = await Promise.all(plan.steps.map(async (step) => {
      const action = step.action;
      const path = "path" in action ? action.path : undefined;
      return {
        id: path === plan.dataDirectory ? "data" : step.id,
        kind: action.kind === "remove-link" ? "command" : action.kind === "purge-packages" ? "package" : action.kind === "remove-account" ? "account" : action.kind === "remove" ? "directory" : "service",
        description: step.description,
        ...(path ? { path, exists: await host.exists(path) } : {}),
      };
    }));
    return { adapter: "node", installation: options.installation, dataDirectory: plan.dataDirectory, targets, retained: plan.retained, steps: plan.steps };
  };
  return {
    async plan() { return describe((await resolvePlan()).plan); },
    async uninstall(input) {
      assertCompleteUninstallConfirmation(input.confirmation);
      const { paths, plan } = await resolvePlan();
      await assertNodeInstallationPrivilege(paths, skip);
      const described = await describe(plan);
      const output = await executeZelavisInstallationPlan(host, plan, input.confirmation);
      return { removed: true, plan: described, output: [...output, "Zelavis installation, configuration and data removed."].join("\n") };
    },
  };
}
