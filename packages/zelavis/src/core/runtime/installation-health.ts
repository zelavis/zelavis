import type { ZelavisInstallationIdentity } from "./installation.js";
import { readNativeInstallationReceipt, type ZelavisInstallHost, type ZelavisInstallPaths } from "./installation-plan.js";

export interface ZelavisDataOwnership { readonly active: boolean; readonly pid?: number; readonly installationRoot?: string; readonly purpose?: "platform" | "maintenance" }
export interface ZelavisUnitState { readonly present: boolean; readonly enabled: boolean; readonly active: boolean; readonly pid?: number; readonly delegates?: boolean }
export interface ZelavisInstallationProbeHost extends ZelavisInstallHost {
  dataOwnership(path: string): Promise<ZelavisDataOwnership>;
  portAvailable(port: number): Promise<boolean>;
  portOwnedBy(pid: number, port: number): Promise<boolean>;
  unitState(unit: string, paths: ZelavisInstallPaths): Promise<ZelavisUnitState>;
  dataOwner(path: string): Promise<{ uid: number; expectedUid?: number } | undefined>;
  agentSupport(): Promise<{ cgroupV2: boolean; cgroupKill: boolean }>;
}

export async function preflightZelavisDataMaintenance(input: { host: ZelavisInstallationProbeHost; paths: ZelavisInstallPaths; system: boolean }): Promise<{ stopPlatform: boolean; owner: ZelavisDataOwnership; unit?: ZelavisUnitState }> {
  const { host, paths } = input;
  const receipt = await readNativeInstallationReceipt(host, paths.prefix);
  const unit = input.system ? await host.unitState("zelavis.service", paths) : undefined;
  let ownUnit = false;
  if (input.system) for (const name of ["zelavis.service", "zelavis-agent.service", "zelavis-traefik.service"]) {
    const contents = await Promise.all(paths.systemdDirectories.map((directory) => host.read(`${directory}/${name}`)));
    const actual = contents.filter((text): text is string => text !== undefined);
    const matches = actual.length > 0 && actual.every((text) => text.includes(`${paths.prefix}/current/`) && text.includes(paths.dataDirectory));
    if (actual.length && !matches) throw new Error(`The existing ${name} belongs to a different layout. Remove or correct that unit before maintenance.`);
    if (name === "zelavis.service") ownUnit = matches;
  }
  const owner = await host.dataOwnership(paths.dataDirectory);
  const stopPlatform = !!(receipt && unit?.active && ownUnit);
  if (owner.active && !(stopPlatform && owner.pid === unit?.pid && owner.installationRoot === paths.prefix && owner.purpose === "platform")) throw new Error(`Platform data at ${paths.dataDirectory} is owned by running PID ${owner.pid ?? "unknown"}. Stop that Platform before maintenance; --force cannot bypass data ownership.`);
  return { stopPlatform, owner, unit };
}

export async function preflightZelavisInstall(input: { host: ZelavisInstallationProbeHost; paths: ZelavisInstallPaths; system: boolean; user?: boolean; force?: boolean; otherPrefixes?: readonly string[] }): Promise<{ stopPlatform: boolean }> {
  const { host, paths } = input;
  const receipt = await readNativeInstallationReceipt(host, paths.prefix);
  if (receipt && (receipt.dataDirectory !== paths.dataDirectory || receipt.configDirectory !== paths.configDirectory || receipt.prefix !== paths.prefix || receipt.mode !== (input.user ? "user" : "system"))) throw new Error("Existing receipt names a different installation layout; remove that installation deliberately before installing here.");
  for (const prefix of input.otherPrefixes ?? []) {
    if (prefix !== paths.prefix && await host.exists(`${prefix}/installation.json`)) throw new Error(`Another Zelavis installation is recorded at ${prefix}. Use that installation for repair/upgrade or uninstall it first. Named instances are not implemented yet.`);
  }
  const command = await host.which("zelavis");
  if (command && command !== paths.commandPath) {
    const link = await host.readlink(command);
    if (!link?.startsWith(`${paths.prefix}/`) && !input.force) throw new Error(`Another Zelavis installation answers on PATH at ${command}${link ? ` -> ${link}` : ""}. Remove it with its originating lifecycle (npm uninstall --global zelavis for npm), fix PATH, or deliberately use --force. Running data/port conflicts cannot be forced.`);
  }
  const { stopPlatform, owner, unit } = await preflightZelavisDataMaintenance(input);
  if (!await host.portAvailable(3000) && !(stopPlatform && owner.active && owner.pid === unit?.pid && await host.portOwnedBy(owner.pid!, 3000))) throw new Error("Port 3000 is occupied by another listener. Stop it before installation; --force cannot bypass a port conflict.");
  return { stopPlatform };
}

export interface ZelavisDoctorCheck { readonly id: string; readonly status: "ok" | "warning" | "error"; readonly detail: string }
export interface ZelavisDoctorReport { readonly installation: ZelavisInstallationIdentity; readonly checks: readonly ZelavisDoctorCheck[]; readonly healthy: boolean }

/** Inspection only: no downloads, SQLite opens, lock acquisition or host commands that mutate. */
export async function inspectZelavisInstallation(input: { host: ZelavisInstallationProbeHost; paths: ZelavisInstallPaths; installation: ZelavisInstallationIdentity }): Promise<ZelavisDoctorReport> {
  const { host, paths, installation } = input;
  const checks: ZelavisDoctorCheck[] = [];
  const check = async (id: string, inspect: () => Promise<{ status: ZelavisDoctorCheck["status"]; detail: string }>) => {
    try { checks.push({ id, ...await inspect() }); }
    catch (error) { checks.push({ id, status: "error", detail: error instanceof Error ? error.message : String(error) }); }
  };
  let receipt: Awaited<ReturnType<typeof readNativeInstallationReceipt>>;
  await check("receipt", async () => {
    receipt = await readNativeInstallationReceipt(host, paths.prefix);
    if (!receipt) return { status: "error", detail: `No installation receipt at ${paths.prefix}/installation.json. npm/source copies use their originating lifecycle.` };
    const matches = receipt.prefix === paths.prefix && receipt.dataDirectory === paths.dataDirectory && receipt.configDirectory === paths.configDirectory && receipt.instance === "default";
    return { status: matches ? "ok" : "error", detail: `${receipt.source} via ${receipt.installedBy}, ${receipt.mode} instance ${receipt.instance}, version ${receipt.version}; ${matches ? "paths match" : "receipt paths disagree with this installation"}.` };
  });
  await check("path", async () => {
    const command = await host.which("zelavis");
    const link = command ? await host.readlink(command) : undefined;
    const matches = !!link?.startsWith(`${paths.prefix}/`);
    return { status: matches ? "ok" : "warning", detail: command ? `PATH answers at ${command}${link ? ` -> ${link}` : ""}; inspected CLI is ${installation.path}.` : `No zelavis on PATH; inspected CLI is ${installation.path}.` };
  });
  await check("release", async () => {
    const manifest = JSON.parse(await host.read(`${paths.prefix}/current/manifest.json`) ?? "null") as { version?: string } | null;
    const node = await host.exists(`${paths.prefix}/current/runtime/node/bin/node`);
    const current = await host.readlink(`${paths.prefix}/current`);
    const matches = !!manifest && manifest.version === receipt?.version && node && (current === `releases/${receipt?.version}` || current === `${paths.prefix}/releases/${receipt?.version}`);
    return { status: matches ? "ok" : "error", detail: `Selected release ${manifest?.version ?? "missing"} via ${current ?? "missing current link"}; private Node ${node ? "present" : "missing"}.` };
  });
  await check("data", async () => {
    const [owner, permissions] = await Promise.all([host.dataOwnership(paths.dataDirectory), host.dataOwner(paths.dataDirectory)]);
    const badOwner = permissions?.expectedUid !== undefined && permissions.uid !== permissions.expectedUid;
    return { status: !permissions || badOwner || owner.active && owner.installationRoot !== paths.prefix ? "error" : "ok", detail: `${paths.dataDirectory}: ${permissions ? `uid ${permissions.uid}, expected ${permissions.expectedUid ?? "unknown"}` : "absent"}; ${owner.active ? `owned by PID ${owner.pid} (${owner.installationRoot ?? "unidentified installation"})` : "no live Platform owner"}.` };
  });
  await check("port:3000", async () => {
    const available = await host.portAvailable(3000);
    const owner = await host.dataOwnership(paths.dataDirectory);
    const ours = owner.active && owner.installationRoot === paths.prefix && owner.purpose === "platform" && !!owner.pid && await host.portOwnedBy(owner.pid, 3000);
    return { status: available || ours ? "ok" : "error", detail: `Port 3000: ${available ? "available" : ours ? `owned by this Platform (PID ${owner.pid})` : "occupied or unavailable to probe; no matching Platform listener proved"}.` };
  });
  if (receipt?.mode === "system") {
    for (const unit of ["zelavis.service", "zelavis-agent.service", "zelavis-traefik.service"]) await check(`unit:${unit}`, async () => {
      const state = await host.unitState(unit, paths);
      const contents = await Promise.all(paths.systemdDirectories.map((directory) => host.read(`${directory}/${unit}`)));
      const actual = contents.filter((text): text is string => text !== undefined);
      const matches = actual.length > 0 && actual.every((text) => text.includes(`${paths.prefix}/current/`) && text.includes(paths.dataDirectory));
      return { status: !state.present || !matches || unit === "zelavis.service" && !state.active ? "error" : "ok", detail: `${unit}: layout ${matches ? "matches" : "differs or is missing"}, ${state.present ? "present" : "absent"}, ${state.enabled ? "enabled" : "disabled"}, ${state.active ? "active" : "inactive"}${state.pid ? `, PID ${state.pid}` : ""}.` };
    });
    await check("agent", async () => {
      const [support, unit] = await Promise.all([host.agentSupport(), host.unitState("zelavis-agent.service", paths)]);
      const qualified = support.cgroupV2 && support.cgroupKill && !!unit.delegates;
      return { status: qualified ? "ok" : "warning", detail: `Agent: cgroup v2 ${support.cgroupV2}, cgroup.kill ${support.cgroupKill}, Delegate ${!!unit.delegates}. ${qualified ? "Required host features present; operation conformance still requires execution." : "Agent containment is not qualified on this host."}` };
    });
    for (const port of [80, 443]) await check(`port:${port}`, async () => ({ status: "ok", detail: `Port ${port}: ${await host.portAvailable(port) ? "available" : "occupied"}; installation does not claim public web ports.` }));
  }
  return { installation, checks, healthy: checks.every((item) => item.status !== "error") };
}
