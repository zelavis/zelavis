import { assertInstallationInstance, assertInstallationPort, installationInstanceScope } from "../../core/runtime/installation-instance.js";
import { acquireNodeInstallerLock } from "../../adapters/_local-ownership.js";
import { preflightZelavisInstall } from "../../core/runtime/installation-health.js";
import { createNodeInstallHost, nodeInstallationPaths, nodeUserInstallationPaths, assertNodeInstallationPrivilege } from "../../adapters/_install-host.js";
import { networkInterfaces } from "node:os";
import { assembleNpmReleaseTree } from "../../adapters/_release-tree.js";
import { executeZelavisInstallationPlan, planZelavisReleaseInstall, validateInstallationPaths, readNativeInstallationReceipt, type ZelavisNativeInstallationReceipt } from "../../core/runtime/installation-plan.js";

/** Host-local acquisition and execution of the shared installation plan. */
export async function runReleaseInstall(args: readonly string[]): Promise<void> {
  let invokingPath: string | undefined, invokingHome: string | undefined;
  let instance = "default", port: number | undefined;
  let source: string | undefined, npmPrepared: string | undefined;
  let dryRun = false, json = false, allowDowngrade = false, user = false, live = false, stageOnly = false;
  // Unset means the default: a server's default instance is reachable, anything else stays local.
  let publicBind: boolean | undefined;
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
    else if (arg === "--from-npm") npmPrepared = value(++i, arg);
    else if (arg === "--installed-by") {
      const origin = value(++i, arg);
      if (!["cli", "script", "deb", "create"].includes(origin)) throw new Error("Invalid installation entry point.");
      installedBy = origin as typeof installedBy;
    }
    else if (arg === "--user") user = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--json") json = true;
    else if (arg === "--force") force = true;
    else if (arg === "--public") publicBind = true;
    else if (arg === "--live") live = true;
    else if (arg === "--stage-only") stageOnly = true;
    else if (arg === "--enable-agent") enableAgent = true;
    else if (arg === "--allow-downgrade") allowDowngrade = true;
    else throw new Error(`Unknown install option: ${arg}`);
  }
  if (source && npmPrepared) throw new Error("Choose either --from-release <path> or --from-npm <path>.");
  if (stageOnly && !npmPrepared) throw new Error("--stage-only prepares a release from --from-npm; there is nothing to prepare from a staged tree.");
  if (stageOnly && live) throw new Error("Choose either --stage-only or --live.");
  if (!source && !npmPrepared) throw new Error("zelavis install requires --from-release <absolute staged-release path> or --from-npm <absolute prepared path>.");
  if (user && enableAgent) throw new Error("User installations do not support the Agent.");
  assertInstallationInstance(instance);
  if (port !== undefined) assertInstallationPort(port);
  if (user && instance !== "default") throw new Error("Named instances require system mode.");
  const host = createNodeInstallHost({ invokingPath });
  const paths = user ? nodeUserInstallationPaths() : nodeInstallationPaths(process.env, instance);
  validateInstallationPaths(paths);
  const system = !user && process.getuid?.() === 0 && !!await host.which("systemctl");
  // A server install ends with a URL you can open, as a WordPress install does. The first-owner
  // token gates who may claim the account; there is deliberately no loopback-only server mode.
  const bindPublic = publicBind ?? (system && instance === "default");
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
  const lock = dryRun ? undefined : await acquireNodeInstallerLock(paths.prefix);
  try {
    // Preparing a release changes nothing about the running installation, so it checks nothing
    // about it: the Platform is expected to be running and to hold its data and port.
    if (stageOnly) {
      const prepared = await assembleNpmReleaseTree(npmPrepared!);
      const release = `${paths.prefix}/releases/${prepared.version}`;
      if (!await host.exists(release)) {
        await host.execute({ kind: "mkdir", path: `${paths.prefix}/releases`, mode: user ? 0o700 : 0o755 });
        await host.execute({ kind: "copy", source: npmPrepared!, path: release });
      }
      console.log(json ? JSON.stringify({ prepared: prepared.version, release }) : `Prepared Zelavis ${prepared.version} at ${release}. Nothing was switched or restarted.`);
      return;
    }
    if (live && (user || !system)) throw new Error("--live swaps a running systemd installation; there is nothing to swap here.");
    const { stopPlatform } = await preflightZelavisInstall({ host, paths, system: probeSystem, user, force, otherPrefixes, port, live });
    // The bootstrap fetched the private Node and the package; this completes the tree.
    if (npmPrepared) await assembleNpmReleaseTree(npmPrepared);
    port ??= (await readNativeInstallationReceipt(host, paths.prefix, instance))?.port ?? 3000;
    // An update keeps the bind the installation already has: moving it would restart the held socket.
    const keptHost = live ? (JSON.parse(await host.read(installationInstanceScope(paths.prefix, instance).runtime) ?? "{}") as { host?: unknown }).host : undefined;
    const plan = await planZelavisReleaseInstall({ host, source: npmPrepared ?? source!, paths, system: dryRun ? probeSystem : system, user, force, port, public: keptHost === undefined ? bindPublic : keptHost === "0.0.0.0", live, allowDowngrade, enableAgent, stopPlatform, sourceKind: npmPrepared ? "package" : await releaseSourceKind(host, paths, instance, source!), installedBy });
    if (dryRun) {
      console.log(json ? JSON.stringify(plan, null, 2) : ["Zelavis install plan", ...plan.steps.map((step) => `  ${step.id}: ${step.description} (idempotent: ${step.idempotent})`), ...plan.warnings, "No changes were made."].join("\n"));
      return;
    }
    for (const warning of plan.warnings) console.error(warning);
    const output = await executeZelavisInstallationPlan(host, plan);
    if (json) console.log(JSON.stringify({ installed: true, plan, output }, null, 2));
    else {
      const address = system && bindPublic ? serverAddress() : "127.0.0.1";
      console.log(`Zelavis instance ${instance} installed.\nOpen the dashboard: http://${address}:${port}/zelavis`);
      if (user) console.log(`Add ${paths.commandPath.slice(0, paths.commandPath.lastIndexOf("/"))} to PATH, then run: zelavis serve${bindPublic ? " --host 0.0.0.0" : ""}`);
      if (system && bindPublic) console.log(`This address is plain HTTP, so claim the owner account now and add a hostname with HTTPS in the setup wizard. If a firewall blocks port ${port}, allow it, or reach it with: ssh -N -L ${port}:127.0.0.1:${port} <user>@<server>`);
      if (system && !bindPublic) console.log(`This instance listens on 127.0.0.1 only. From your local machine: ssh -N -L ${port}:127.0.0.1:${port} <user>@<server>`);
      for (const line of output) console.log(line);
    }
  } finally {
    await lock?.release();
  }
}

/** The server's first routable IPv4 address, for the URL to open; a placeholder when there is none. */
function serverAddress(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) return entry.address;
    }
  }
  return "<server-ip>";
}

/**
 * Where an installation came from. A release tree that is already one of this installation's
 * own (a rollback selects the previous one again) is the same installation, so it keeps its
 * receipt's source instead of becoming a "release" install.
 */
async function releaseSourceKind(host: Parameters<typeof readNativeInstallationReceipt>[0], paths: { prefix: string }, instance: string, source: string): Promise<"release" | "package"> {
  if (!source.startsWith(`${paths.prefix}/releases/`)) return "release";
  return (await readNativeInstallationReceipt(host, paths.prefix, instance).catch(() => undefined))?.source ?? "release";
}
