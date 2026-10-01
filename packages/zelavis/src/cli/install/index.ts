import { assertInstallationInstance, assertInstallationPort } from "../../core/runtime/installation-instance.js";
import { acquireNodeInstallerLock } from "../../adapters/_local-ownership.js";
import { preflightZelavisInstall } from "../../core/runtime/installation-health.js";
import { createNodeInstallHost, nodeInstallationPaths, nodeUserInstallationPaths, assertNodeInstallationPrivilege } from "../../adapters/_install-host.js";
import { acquirePackageRelease, EXACT_INSTALL_VERSION } from "../../adapters/_package-release.js";
import { executeZelavisInstallationPlan, planZelavisReleaseInstall, validateInstallationPaths, readNativeInstallationReceipt, type ZelavisNativeInstallationReceipt } from "../../core/runtime/installation-plan.js";

/** Host-local acquisition and execution of the shared installation plan. */
export async function runReleaseInstall(args: readonly string[]): Promise<void> {
  let invokingPath: string | undefined, invokingHome: string | undefined;
  let instance = "default", port: number | undefined;
  let source: string | undefined, from: string | undefined, version: string | undefined;
  let dryRun = false, json = false, publicBind = false, allowDowngrade = false, user = false;
  let sourceKind: "release" | "package" = "release";
  let installedBy: ZelavisNativeInstallationReceipt["installedBy"] = "cli";
  let force = process.env.ZELAVIS_FORCE_BIN === "1", enableAgent = process.env.ZELAVIS_ENABLE_AGENT === "1";
  const value = (i: number, flag: string) => {
    const result = args[i];
    if (!result || result.startsWith("--")) throw new Error(`${flag} requires a value.`);
    return result;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--instance") instance = value(++i, arg);
    else if (arg === "--port") port = Number(value(++i, arg));
    else if (arg === "--from-release") source = value(++i, arg);
    else if (arg === "--invoking-home") invokingHome = value(++i, arg);
    else if (arg === "--invoking-path") invokingPath = value(++i, arg);
    else if (arg === "--from") from = value(++i, arg);
    else if (arg === "--source") {
      const sourceValue = value(++i, arg);
      if (sourceValue !== "package" && sourceValue !== "release") throw new Error("Invalid install source.");
      sourceKind = sourceValue;
    }
    else if (arg === "--installed-by") {
      const origin = value(++i, arg);
      if (!["cli", "archive", "deb", "create"].includes(origin)) throw new Error("Invalid installation entry point.");
      installedBy = origin as typeof installedBy;
    }
    else if (arg === "--version") version = value(++i, arg);
    else if (arg === "--user") user = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--json") json = true;
    else if (arg === "--force") force = true;
    else if (arg === "--public") publicBind = true;
    else if (arg === "--enable-agent") enableAgent = true;
    else if (arg === "--allow-downgrade") allowDowngrade = true;
    else throw new Error(`Unknown install option: ${arg}`);
  }
  if (from !== undefined && from !== "package") throw new Error("--from supports package; staged trees use --from-release <absolute path>.");
  if (source && from || version && !from) throw new Error("Choose either --from-release <path> or --from package --version <exact version>.");
  if (from && (!version || !EXACT_INSTALL_VERSION.test(version))) throw new Error("Package installation requires --version <exact version>; tags and ranges are refused.");
  if (!source && !from) throw new Error("zelavis install requires --from-release <absolute staged-release path> or --from package --version <exact version>.");
  if (user && enableAgent) throw new Error("User installations do not support the Agent.");
  assertInstallationInstance(instance);
  if (port !== undefined) assertInstallationPort(port);
  if (user && instance !== "default") throw new Error("Named instances require system mode.");
  const host = createNodeInstallHost({ invokingPath });
  const paths = user ? nodeUserInstallationPaths() : nodeInstallationPaths(process.env, instance);
  validateInstallationPaths(paths);
  const system = !user && process.getuid?.() === 0 && !!await host.which("systemctl");
  if (!user && paths.prefix === "/opt/zelavis") {
    if (process.platform !== "linux") throw new Error("System installation requires Linux with systemd; use --user on this host.");
    if (!dryRun && process.getuid?.() !== 0) throw new Error("System installation must run as root. Use create-zelavis for safe elevation, or --user.");
    if (!dryRun && !system) throw new Error("System installation requires systemd.");
  }
  if (system && !dryRun) await assertNodeInstallationPrivilege(paths);
  const probeSystem = !user && process.platform === "linux" && !!await host.which("systemctl");
  const invokingUserPrefix = invokingHome ? nodeUserInstallationPaths(invokingHome).prefix : undefined;
  if (invokingUserPrefix) validateInstallationPaths(nodeUserInstallationPaths(invokingHome));
  const otherPrefixes = paths.prefix === "/opt/zelavis" || user ? [nodeInstallationPaths().prefix, nodeUserInstallationPaths().prefix, ...invokingUserPrefix ? [invokingUserPrefix] : []] : [];
  // A package dry-run describes acquisition without downloads or temporary state.
  if (from && dryRun) {
    await preflightZelavisInstall({ host, paths, system: probeSystem, user, force, otherPrefixes, port });
    const overview = { operation: "install", source: "package", version, mode: user ? "user" : "system", paths, steps: ["Verify exact npm version metadata", "Download and verify matching prebuilt release SHA-256", "Plan release installation; detailed steps require the verified tree"], public: publicBind };
    console.log(json ? JSON.stringify(overview, null, 2) : `${JSON.stringify(overview, null, 2)}\nNo changes were made.`);
    return;
  }
  const lock = dryRun ? undefined : await acquireNodeInstallerLock(paths.prefix);
  let acquired: Awaited<ReturnType<typeof acquirePackageRelease>> | undefined;
  try {
    const { stopPlatform } = await preflightZelavisInstall({ host, paths, system: probeSystem, user, force, otherPrefixes, port });
    acquired = from ? await acquirePackageRelease(version!) : undefined;
    port ??= (await readNativeInstallationReceipt(host, paths.prefix, instance))?.port ?? 3000;
    const plan = await planZelavisReleaseInstall({ host, source: acquired?.source ?? source!, paths, system: dryRun ? probeSystem : system, user, force, port, public: publicBind, allowDowngrade, enableAgent, stopPlatform, sourceKind: from ? "package" : sourceKind, installedBy });
    if (dryRun) {
      console.log(json ? JSON.stringify(plan, null, 2) : ["Zelavis install plan", ...plan.steps.map((step) => `  ${step.id}: ${step.description} (idempotent: ${step.idempotent})`), ...plan.warnings, "No changes were made."].join("\n"));
      return;
    }
    for (const warning of plan.warnings) console.error(warning);
    const output = await executeZelavisInstallationPlan(host, plan);
    if (json) console.log(JSON.stringify({ installed: true, plan, output }, null, 2));
    else {
      console.log(`Zelavis instance ${instance} installed.\nDashboard: http://127.0.0.1:${port}/zelavis`);
      if (user) console.log(`Add ${paths.commandPath.slice(0, paths.commandPath.lastIndexOf("/"))} to PATH, then run: zelavis serve${publicBind ? " --host 0.0.0.0" : ""}`);
      if (system && !publicBind) console.log(`From your local machine: ssh -N -L ${port}:127.0.0.1:${port} <user>@<server>`);
      for (const line of output) console.log(line);
    }
  } finally {
    try { await acquired?.cleanup(); } finally { await lock?.release(); }
  }
}
