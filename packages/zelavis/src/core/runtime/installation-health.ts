import { Cause, Effect } from "effect";
import { integration, IntegrationFailure, present, type TaggedFailure } from "./effect-boundary.js";
import { installationInstanceScope } from "./installation-instance.js";
import type { ZelavisInstallationIdentity } from "./installation.js";
import { readNativeInstallationReceipt, readNativeInstallationReceiptProgram, type ZelavisInstallHost, type ZelavisInstallPaths } from "./installation-plan.js";

export interface ZelavisDataOwnership { readonly active: boolean; readonly pid?: number; readonly supervisorPid?: number; readonly installationRoot?: string; readonly purpose?: "platform" | "maintenance" }
export interface ZelavisUnitState { readonly present: boolean; readonly enabled: boolean; readonly active: boolean; readonly pid?: number; readonly delegates?: boolean }
export interface ZelavisInstallationProbeHost extends ZelavisInstallHost {
  dataOwnership(path: string): Promise<ZelavisDataOwnership>;
  portAvailable(port: number): Promise<boolean>;
  portOwnedBy(pid: number, port: number): Promise<boolean>;
  unitState(unit: string, paths: ZelavisInstallPaths): Promise<ZelavisUnitState>;
  dataOwner(path: string, account?: string): Promise<{ uid: number; expectedUid?: number } | undefined>;
  agentSupport(unit?: string): Promise<{ cgroupV2: boolean; cgroupKill: boolean }>;
}

export const preflightZelavisDataMaintenanceProgram = Effect.fn("Installation.preflightZelavisDataMaintenance")(function* (input: { host: ZelavisInstallationProbeHost; paths: ZelavisInstallPaths; system: boolean; live?: boolean }): Effect.fn.Return<{ stopPlatform: boolean; owner: ZelavisDataOwnership; unit?: ZelavisUnitState }, TaggedFailure> {
  const { host, paths } = input;
  const scope = installationInstanceScope(paths.prefix, paths.instance);
  const receipt = (yield* readNativeInstallationReceiptProgram(host, paths.prefix, paths.instance));
  const unit = input.system ? (yield* integration(() => host.unitState(scope.units[0], paths))) : undefined;
  let ownUnit = false;
  if (input.system) for (const name of [...scope.units.slice(0, scope.named ? 2 : 3), scope.units[scope.units.length - 1]]) {
    const contents = (yield* readUnitContentsProgram(host, paths, name));
    const actual = contents.filter((text): text is string => text !== undefined);
    const matches = actual.length > 0 && actual.every((text) => text.includes(`${scope.current}/`) && text.includes(paths.dataDirectory));
    if (actual.length && !matches) return yield* new IntegrationFailure(new Error(`The existing ${name} belongs to a different layout. Remove or correct that unit before maintenance.`));
    if (name === scope.units[0]) ownUnit = matches;
  }
  const owner = (yield* integration(() => host.dataOwnership(paths.dataDirectory)));
  // A live swap leaves the running Platform alone, so its own lock is expected; a stop is only for the full plan.
  const stopPlatform = !!(receipt && unit?.active && ownUnit) && !input.live;
  // A user installation has no unit: the running Platform is whichever process holds the data lock.
  const userLive = !!(input.live && !input.system && receipt?.mode === "user");
  const live = !!(input.live && receipt && unit?.active && ownUnit) || userLive;
  if (owner.active && !((stopPlatform || live) && (userLive || (owner.supervisorPid ?? owner.pid) === unit?.pid) && owner.installationRoot === paths.prefix && owner.purpose === "platform")) return yield* new IntegrationFailure(new Error(`Platform data at ${paths.dataDirectory} is owned by running PID ${owner.pid ?? "unknown"}. Stop that Platform before maintenance; --force cannot bypass data ownership.`));
  return { stopPlatform, owner, unit };
});
export function preflightZelavisDataMaintenance(input: { host: ZelavisInstallationProbeHost; paths: ZelavisInstallPaths; system: boolean; live?: boolean }): Promise<{ stopPlatform: boolean; owner: ZelavisDataOwnership; unit?: ZelavisUnitState }> { return present(preflightZelavisDataMaintenanceProgram(input)); }

export const preflightZelavisInstallProgram = Effect.fn("Installation.preflightZelavisInstall")(function* (input: { host: ZelavisInstallationProbeHost; paths: ZelavisInstallPaths; system: boolean; user?: boolean; force?: boolean; otherPrefixes?: readonly string[]; port?: number; live?: boolean }): Effect.fn.Return<{ stopPlatform: boolean }, TaggedFailure> {
  const { host, paths } = input;
  const scope = installationInstanceScope(paths.prefix, paths.instance);
  const receipt = (yield* readNativeInstallationReceiptProgram(host, paths.prefix, paths.instance));
  if (receipt && (receipt.dataDirectory !== paths.dataDirectory || receipt.configDirectory !== paths.configDirectory || receipt.prefix !== paths.prefix || receipt.mode !== (input.user ? "user" : "system"))) return yield* new IntegrationFailure(new Error("Existing receipt names a different installation layout; remove that installation deliberately before installing here."));
  for (const prefix of input.otherPrefixes ?? []) {
    if (prefix !== paths.prefix && ((yield* integration(() => host.exists(`${prefix}/installation.json`))) || ((yield* integration(() => host.listInstances?.(prefix))) ?? []).length > 0)) return yield* new IntegrationFailure(new Error(`Another Zelavis installation is recorded at ${prefix}. Use that installation for repair/upgrade or uninstall it first. System instances share a prefix; remove this other layout first.`));
  }
  const port = input.port ?? receipt?.port ?? 3000;
  for (const name of (yield* integration(() => host.listInstances?.(paths.prefix))) ?? []) {
    if (name === scope.instance) continue;
    const other = (yield* readNativeInstallationReceiptProgram(host, paths.prefix, name));
    if (other?.port === port) return yield* new IntegrationFailure(new Error(`Port ${port} is reserved by instance ${name} at ${other.dataDirectory}. Choose another --port even if that instance is stopped.`));
    if (other?.dataDirectory === paths.dataDirectory || other?.configDirectory === paths.configDirectory) return yield* new IntegrationFailure(new Error(`Instance ${name} already owns the requested data or configuration directory.`));
  }
  if (scope.named && !receipt && input.port === undefined) return yield* new IntegrationFailure(new Error("A new named instance requires an explicit --port."));
  if (!scope.named && !input.user) {
    const edge = (yield* integration(() => host.read(`${paths.prefix}/edge-owner.json`)));
    if (edge) { const owner = JSON.parse(edge); if (owner.schemaVersion !== 1 || owner.prefix !== paths.prefix || owner.instance !== scope.instance || owner.dataDirectory !== paths.dataDirectory) return yield* new IntegrationFailure(new Error(`Host Edge belongs to another instance or layout: ${owner.instance ?? "unknown"}.`)); }
  }
  const command = (yield* integration(() => host.which("zelavis")));
  if (command && command !== paths.commandPath) {
    const link = (yield* integration(() => host.readlink(command)));
    if (!link?.startsWith(`${paths.prefix}/`) && !input.force) return yield* new IntegrationFailure(new Error(`Another Zelavis installation answers on PATH at ${command}${link ? ` -> ${link}` : ""}. Remove it with its originating lifecycle (npm uninstall --global zelavis for npm), fix PATH, or deliberately use --force. Running data/port conflicts cannot be forced.`));
  }
  const { stopPlatform, owner, unit } = (yield* preflightZelavisDataMaintenanceProgram(input));
  // With socket activation systemd holds the port even while the Platform is stopped; that is this installation's own socket.
  const socket = input.system && receipt?.port === port ? (yield* integration(() => host.unitState(scope.socket, paths))) : undefined;
  const heldByOwnSocket = !!socket?.present && socket.active;
  const platformHoldsPort = (stopPlatform || input.live) && owner.active && ((owner.supervisorPid ?? owner.pid) === unit?.pid || !input.system) && (yield* integration(() => host.portOwnedBy((owner.supervisorPid ?? owner.pid)!, port)));
  if (!(yield* integration(() => host.portAvailable(port))) && !heldByOwnSocket && !platformHoldsPort) return yield* new IntegrationFailure(new Error(`Port ${port} is occupied by another listener. Stop it before installation; --force cannot bypass a port conflict.`));
  if (input.system && !scope.named) yield* assertProductionEdgePortsProgram({ host, paths, port, edge: receipt?.edge === true });
  return { stopPlatform };
});
/** Both fresh installation and live root selection refuse foreign ingress listeners. */
export const assertProductionEdgePortsProgram = Effect.fn("Installation.productionEdgePorts")(function* (input: {
  readonly host: ZelavisInstallationProbeHost; readonly paths: ZelavisInstallPaths;
  readonly port: number; readonly edge: boolean;
}): Effect.fn.Return<void, TaggedFailure> {
  if ([80, 443].includes(input.port)) return yield* new IntegrationFailure(new Error("The Platform management port must be distinct from production ingress ports 80 and 443."));
  const unit = input.edge ? yield* integration(() => input.host.unitState("zelavis-traefik.service", input.paths)) : undefined;
  for (const publicPort of [80, 443]) {
    const available = yield* integration(() => input.host.portAvailable(publicPort));
    const owned = unit?.active && unit.pid && (yield* integration(() => input.host.portOwnedBy(unit.pid!, publicPort)));
    if (!available && !owned) return yield* new IntegrationFailure(new Error(`Production ingress port ${publicPort} is occupied by another listener. Zelavis will not replace its owner.`));
  }
});
export function preflightZelavisInstall(input: { host: ZelavisInstallationProbeHost; paths: ZelavisInstallPaths; system: boolean; user?: boolean; force?: boolean; otherPrefixes?: readonly string[]; port?: number; live?: boolean }): Promise<{ stopPlatform: boolean }> { return present(preflightZelavisInstallProgram(input)); }

export interface ZelavisDoctorCheck { readonly id: string; readonly status: "ok" | "warning" | "error"; readonly detail: string }
export interface ZelavisDoctorReport { readonly instance: string; readonly installation: ZelavisInstallationIdentity; readonly checks: readonly ZelavisDoctorCheck[]; readonly healthy: boolean }

/** Inspection only: no downloads, SQLite opens, lock acquisition or host commands that mutate. */
export const inspectZelavisInstallationProgram = Effect.fn("Installation.inspectZelavisInstallation")(function* (input: { host: ZelavisInstallationProbeHost; paths: ZelavisInstallPaths; installation: ZelavisInstallationIdentity }): Effect.fn.Return<ZelavisDoctorReport, TaggedFailure> {
  const { host, paths, installation } = input;
  const scope = installationInstanceScope(paths.prefix, paths.instance);
  const checks: ZelavisDoctorCheck[] = [];
  const check = Effect.fn("Installation.inspectCheck")(function* (id: string, inspect: () => Effect.Effect<{ status: ZelavisDoctorCheck["status"]; detail: string }, TaggedFailure>) {
    const result = yield* Effect.exit(Effect.suspend(inspect));
    if (result._tag === "Success") checks.push({ id, ...result.value });
    else { const error = Cause.squash(result.cause); checks.push({ id, status: "error", detail: error instanceof Error ? error.message : String(error) }); }
  });
  let receipt: Awaited<ReturnType<typeof readNativeInstallationReceipt>>;
  (yield* check("receipt", () => Effect.gen(function* () {
    receipt = (yield* readNativeInstallationReceiptProgram(host, paths.prefix, paths.instance));
    if (!receipt) return { status: "error", detail: `No installation receipt at ${scope.receipt}. npm/source copies use their originating lifecycle.` };
    const matches = receipt.prefix === paths.prefix && receipt.dataDirectory === paths.dataDirectory && receipt.configDirectory === paths.configDirectory && receipt.instance === scope.instance;
    return { status: matches ? "ok" : "error", detail: `${receipt.source} via ${receipt.installedBy}, ${receipt.mode} instance ${receipt.instance}, version ${receipt.version}; ${matches ? "paths match" : "receipt paths disagree with this installation"}.` };
  })));
  (yield* check("path", () => Effect.gen(function* () {
    const command = (yield* integration(() => host.which("zelavis")));
    const link = command ? (yield* integration(() => host.readlink(command))) : undefined;
    const matches = !!link?.startsWith(`${paths.prefix}/`);
    return { status: matches ? "ok" : "warning", detail: command ? `PATH answers at ${command}${link ? ` -> ${link}` : ""}; inspected CLI is ${installation.path}.` : `No zelavis on PATH; inspected CLI is ${installation.path}.` };
  })));
  (yield* check("release", () => Effect.gen(function* () {
    const manifest = JSON.parse((yield* integration(() => host.read(`${scope.current}/manifest.json`))) ?? "null") as { version?: string } | null;
    const node = (yield* integration(() => host.exists(`${scope.current}/runtime/node/bin/node`)));
    const current = (yield* integration(() => host.readlink(`${scope.current}`)));
    const matches = !!manifest && manifest.version === receipt?.version && node && (current === `releases/${receipt?.version}` || current === `${paths.prefix}/releases/${receipt?.version}`);
    return { status: matches ? "ok" : "error", detail: `Selected release ${manifest?.version ?? "missing"} via ${current ?? "missing current link"}; private Node ${node ? "present" : "missing"}.` };
  })));
  (yield* check("runtime-descriptor", () => Effect.gen(function* () {
    const value = JSON.parse((yield* integration(() => host.read(scope.runtime))) ?? "null");
    const matches = value?.schemaVersion === 1 && value.version === receipt?.version && value.instance === scope.instance && value.prefix === paths.prefix && value.dataDirectory === paths.dataDirectory && value.configDirectory === paths.configDirectory && value.port === receipt?.port && value.edge === receipt?.edge && ["127.0.0.1", "0.0.0.0"].includes(value.host);
    return { status: matches ? "ok" : "error", detail: `${scope.runtime}: ${matches ? "matches receipt and selected paths" : "missing or disagrees with receipt"}; no bootstrap secrets inspected.` };
  })));
  (yield* check("data", () => Effect.gen(function* () {
    const [owner, permissions] = (yield* Effect.all([integration(() => host.dataOwnership(paths.dataDirectory)), integration(() => host.dataOwner(paths.dataDirectory, receipt?.mode === "system" ? scope.account : undefined))], { concurrency: 2 }));
    const badOwner = permissions?.expectedUid !== undefined && permissions.uid !== permissions.expectedUid;
    return { status: !permissions || badOwner || owner.active && owner.installationRoot !== paths.prefix ? "error" : "ok", detail: `${paths.dataDirectory}: ${permissions ? `uid ${permissions.uid}, expected ${permissions.expectedUid ?? "unknown"}` : "absent"}; ${owner.active ? `owned by PID ${owner.pid} (${owner.installationRoot ?? "unidentified installation"})` : "no live Platform owner"}.` };
  })));
  const port = receipt?.port ?? 3000;
  (yield* check(`port:${port}`, () => Effect.gen(function* () {
    const available = (yield* integration(() => host.portAvailable(port)));
    const owner = (yield* integration(() => host.dataOwnership(paths.dataDirectory)));
    const ours = owner.active && owner.installationRoot === paths.prefix && owner.purpose === "platform" && !!owner.pid && (yield* integration(() => host.portOwnedBy((owner.supervisorPid ?? owner.pid)!, port)));
    // Socket activation: systemd holds the port, with or without the Platform running.
    const socket = receipt?.mode === "system" ? (yield* integration(() => host.unitState(scope.socket, paths))) : undefined;
    const heldBySocket = !available && !ours && !!socket?.present && socket.active;
    return { status: available || ours || heldBySocket ? "ok" : "error", detail: `Port ${port}: ${available ? "available" : ours ? `owned by this Platform host (PID ${owner.supervisorPid ?? owner.pid})` : heldBySocket ? `held by systemd (${scope.socket}); the Platform serves it` : "occupied or unavailable to probe; no matching Platform listener proved"}.` };
  })));
  if (receipt?.mode === "system") {
    for (const unit of [...scope.units.slice(0, scope.named ? 2 : 3), scope.units[scope.units.length - 1]]) (yield* check(`unit:${unit}`, () => Effect.gen(function* () {
      const state = (yield* integration(() => host.unitState(unit, paths)));
      const contents = (yield* readUnitContentsProgram(host, paths, unit));
      const actual = contents.filter((text): text is string => text !== undefined);
      const matches = actual.length > 0 && actual.every((text) => text.includes(`${scope.current}/`) && text.includes(paths.dataDirectory));
      return { status: !state.present || !matches || (unit === scope.units[0] || unit === scope.units[scope.units.length - 1]) && !state.active ? "error" : "ok", detail: `${unit}: layout ${matches ? "matches" : "differs or is missing"}, ${state.present ? "present" : "absent"}, ${state.enabled ? "enabled" : "disabled"}, ${state.active ? "active" : "inactive"}${state.pid ? `, PID ${state.pid}` : ""}.` };
    })));
    (yield* check("socket", () => Effect.gen(function* () {
      const state = (yield* integration(() => host.unitState(scope.socket, paths)));
      const held = state.present && state.enabled && state.active;
      return { status: held ? "ok" : "warning", detail: held ? `${scope.socket} holds the dashboard port, so a restart or update queues connections instead of refusing them.` : `${scope.socket} is missing or not running, so a restart briefly refuses connections. Run the installer again to enable it.` };
    })));
    (yield* check("update-watch", () => Effect.gen(function* () {
      const state = (yield* integration(() => host.unitState(scope.updatePath, paths)));
      const armed = state.present && state.enabled && state.active;
      return { status: armed ? "ok" : "warning", detail: armed ? `Dashboard updates are armed: ${scope.updatePath} is watching for requests.` : `Dashboard updates are off (${scope.updatePath} is missing or not running). Run the installer again to enable them.` };
    })));
    (yield* check("agent", () => Effect.gen(function* () {
      const [support, unit] = (yield* Effect.all([integration(() => host.agentSupport(scope.units[1])), integration(() => host.unitState(scope.units[1], paths))], { concurrency: 2 }));
      const qualified = support.cgroupV2 && support.cgroupKill && !!unit.delegates;
      return { status: qualified ? "ok" : "warning", detail: `Agent: cgroup v2 ${support.cgroupV2}, cgroup.kill ${support.cgroupKill}, Delegate ${!!unit.delegates}. ${qualified ? "Required host features present; operation conformance still requires execution." : "Agent containment is not qualified on this host."}` };
    })));
    (yield* check("host-agent", () => Effect.gen(function* () {
      const name = scope.units[scope.units.length - 1];
      const [support, unit] = (yield* Effect.all([integration(() => host.agentSupport(name)), integration(() => host.unitState(name, paths))], { concurrency: 2 }));
      const qualified = unit.active && unit.delegates && support.cgroupV2 && support.cgroupKill;
      return { status: qualified ? "ok" : "error", detail: `Host operation Agent: active ${unit.active}, cgroup v2 ${support.cgroupV2}, cgroup.kill ${support.cgroupKill}, Delegate ${!!unit.delegates}.` };
    })));
    (yield* check("edge-owner", () => Effect.gen(function* () {
      const content = (yield* integration(() => host.read(`${paths.prefix}/edge-owner.json`)));
      const owner = content ? JSON.parse(content) : undefined;
      const lock = (yield* integration(() => host.exists(`${paths.prefix}/.edge-owner.lock`)));
      const ours = lock && owner?.schemaVersion === 1 && owner.prefix === paths.prefix && owner.instance === scope.instance && owner.dataDirectory === paths.dataDirectory;
      return { status: receipt?.edge && !ours ? "error" : "ok", detail: scope.named ? `Edge off; host owner ${owner?.instance ?? "none"}.` : `Host Edge reservation ${ours ? "matches" : "missing or foreign"}.` };
    })));
    for (const port of [80, 443]) (yield* check(`port:${port}`, () => Effect.gen(function* () {
      const available = yield* integration(() => host.portAvailable(port));
      if (!receipt?.edge) return { status: "ok", detail: `Port ${port}: ${available ? "available" : "occupied"}; this instance has no host Edge authority.` };
      const edge = yield* integration(() => host.unitState("zelavis-traefik.service", paths));
      const owned = edge.active && edge.enabled && edge.pid && (yield* integration(() => host.portOwnedBy(edge.pid!, port)));
      return { status: owned ? "ok" : "error", detail: `Production ingress port ${port}: ${owned ? `owned by Zelavis Traefik (PID ${edge.pid})` : "no enabled, active Zelavis Traefik listener proved"}.` };
    })));
  }
  return { instance: scope.instance, installation, checks, healthy: checks.every((item) => item.status !== "error") };
});
export function inspectZelavisInstallation(input: { host: ZelavisInstallationProbeHost; paths: ZelavisInstallPaths; installation: ZelavisInstallationIdentity }): Promise<ZelavisDoctorReport> { return present(inspectZelavisInstallationProgram(input)); }


const readUnitContentsProgram = Effect.fn("Installation.readUnitContents")(function* (host: ZelavisInstallHost, paths: ZelavisInstallPaths, unit: string): Effect.fn.Return<(string | undefined)[], TaggedFailure> {
  const scope = installationInstanceScope(paths.prefix, paths.instance);
  const template = unit === scope.units[scope.units.length - 1] ? scope.templates[scope.templates.length - 1] : scope.templates[scope.units.indexOf(unit)];
  const result: (string | undefined)[] = [];
  for (const directory of paths.systemdDirectories) {
    const concrete = (yield* integration(() => host.read(`${directory}/${unit}`)));
    const contents = concrete ?? (scope.named ? (yield* integration(() => host.read(`${directory}/${template}`))) : undefined);
    result.push(contents?.replaceAll("%i", scope.instance));
  }
  return result;
});
