import { Effect } from "effect";
import { evaluate, integration, IntegrationFailure, present, type TaggedFailure } from "./effect-boundary.js";
import { assertInstallationInstance, assertInstallationPort, installationInstanceScope } from "./installation-instance.js";
import {
  assertCompleteUninstallConfirmation,
  type ZelavisInstallationIdentity,
} from "./installation.js";

/** Host-local actions. Plans carry data, never host code or secret tokens. */
export type ZelavisInstallAction =
  | { readonly kind: "mkdir"; readonly path: string; readonly mode?: number }
  | { readonly kind: "copy"; readonly source: string; readonly path: string }
  | { readonly kind: "link"; readonly target: string; readonly path: string; readonly atomic?: boolean }
  | { readonly kind: "write"; readonly path: string; readonly content: string; readonly mode: number; readonly ifAbsent?: boolean; readonly atomic?: boolean }
  | { readonly kind: "bootstrap"; readonly path: string; readonly dataDirectory?: string; readonly public?: boolean }
  | { readonly kind: "agent-environment"; readonly path: string; readonly endpoint: string; readonly variable?: "ZELAVIS_HOST_OPERATIONS_ENDPOINT" }
  | { readonly kind: "command"; readonly command: string; readonly args: readonly string[]; readonly ignoreFailure?: boolean }
  | { readonly kind: "remove"; readonly path: string; readonly recursive?: boolean }
  | { readonly kind: "remove-link"; readonly path: string; readonly prefix: string }
  | { readonly kind: "reserve-data"; readonly path: string }
  | { readonly kind: "release-data" }
  | { readonly kind: "restore-package-policy"; readonly stateDirectory: string; readonly policy: string }
  | { readonly kind: "purge-packages" }
  | { readonly kind: "claim-edge"; readonly prefix: string; readonly instance: string; readonly dataDirectory: string }
  | { readonly kind: "release-edge"; readonly prefix: string; readonly instance: string; readonly dataDirectory: string }
  | { readonly kind: "remove-account"; readonly account?: string; readonly dataDirectory: string; readonly ownsUser: boolean; readonly ownsGroup: boolean };

export interface ZelavisInstallStep {
  readonly id: string;
  readonly description: string;
  readonly idempotent: boolean;
  readonly action: ZelavisInstallAction;
}

export interface ZelavisHostInstallationPlan {
  readonly operation: "install" | "uninstall";
  readonly installation: ZelavisInstallationIdentity;
  /** Selected host-local instance. */
  readonly instance: string;
  readonly dataDirectory: string;
  readonly steps: readonly ZelavisInstallStep[];
  readonly warnings: readonly string[];
  readonly retained: readonly string[];
}

/** The planner can inspect a fake host; only execute mutates the real host. */
export interface ZelavisInstallHost {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string | undefined>;
  readlink(path: string): Promise<string | undefined>;
  which(command: string, plannedCommandPath?: string): Promise<string | undefined>;
  accountExists(kind: "user" | "group", name: string): Promise<boolean>;
  listInstances?(prefix: string): Promise<readonly string[]>;
  releaseMaintenance?(): Promise<void>;
  execute(action: ZelavisInstallAction): Promise<string | undefined>;
}

export interface ZelavisInstallPaths {
  readonly prefix: string;
  readonly instance?: string;
  readonly dataDirectory: string;
  readonly configDirectory: string;
  readonly commandPath: string;
  readonly systemCommandPath: string;
  readonly systemdDirectories: readonly string[];
}

const UNSAFE_ROOTS = new Set("/ /Applications /Library /System /Users /bin /dev /etc /home /lib /media /mnt /opt /private /proc /root /run /sbin /srv /sys /tmp /usr /var".split(" "));

export function assertInstallationPath(path: string, label: string, name?: string): void {
  if (/[\x00-\x1f\x7f]/u.test(path)) throw new Error(`Refusing control characters in ${label} path.`);
  if (!path.startsWith("/")) throw new Error(`Refusing non-absolute ${label} path: ${path}`);
  if (UNSAFE_ROOTS.has(path)) throw new Error(`Refusing unsafe ${label} path: ${path}`);
  if (/\/\/|\/(?:\.|\.\.)(?:\/|$)/u.test(path) || path.endsWith("/")) {
    throw new Error(`Refusing non-normalized ${label} path: ${path}`);
  }
  if (name && path.slice(path.lastIndexOf("/") + 1) !== name) {
    throw new Error(`Refusing ${label} path whose name is not ${name}: ${path}`);
  }
}

export function validateInstallationPaths(paths: ZelavisInstallPaths): void {
  assertInstallationInstance(paths.instance ?? "default");
  assertInstallationPath(paths.prefix, "installation root");
  assertInstallationPath(paths.dataDirectory, "data directory");
  assertInstallationPath(paths.configDirectory, "configuration directory");
  if (paths.instance && paths.instance !== "default" && (!paths.dataDirectory.endsWith(`-${paths.instance}`) || !paths.configDirectory.endsWith(`-${paths.instance}`))) throw new Error("Named instance data/config directories must end in the instance suffix.");
  for (const path of paths.systemdDirectories) assertInstallationPath(path, "systemd directory");
  assertInstallationPath(paths.commandPath, "command", "zelavis");
  assertInstallationPath(paths.systemCommandPath, "system command", "zelavis");
}

export interface ZelavisNativeInstallationReceipt {
  readonly schemaVersion: 2;
  readonly port: number;
  readonly edge: boolean;
  readonly mode: "system" | "user";
  readonly source: "release" | "package";
  readonly instance: string;
  readonly installedBy: "script" | "deb" | "create" | "cli";
  readonly version: string;
  readonly prefix: string;
  readonly configDirectory: string;
  readonly dataDirectory: string;
  readonly commandPath: string;
  readonly ownsUser: boolean;
  readonly ownsGroup: boolean;
}

export const readNativeInstallationReceiptProgram = Effect.fn("Installation.readNativeInstallationReceipt")(function* (host: ZelavisInstallHost, prefix: string, instance = "default"): Effect.fn.Return<ZelavisNativeInstallationReceipt | undefined, TaggedFailure> {
  const scope = installationInstanceScope(prefix, instance);
  const content = (yield* integration(() => host.read(scope.receipt)));
  if (content === undefined) return undefined;
  const value = yield* evaluate(() => JSON.parse(content) as ZelavisNativeInstallationReceipt);
  if (!value || value.schemaVersion !== 2 || typeof value.edge !== "boolean" || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || typeof value.dataDirectory !== "string" ||
      !["system", "user"].includes(value.mode) || !["release", "package"].includes(value.source) ||
      value.instance !== instance || !["script", "deb", "create", "cli"].includes(value.installedBy) ||
      typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/u.test(value.version) || typeof value.prefix !== "string" || typeof value.configDirectory !== "string" || typeof value.commandPath !== "string" || typeof value.ownsUser !== "boolean" || typeof value.ownsGroup !== "boolean") {
    return yield* new IntegrationFailure(new Error(`Native installation receipt at ${scope.receipt} is malformed.`));
  }
  yield* evaluate(() => assertInstallationInstance(value.instance));
  if (value.mode === "user" && value.edge || value.instance !== "default" && (value.mode === "user" || value.edge)) return yield* new IntegrationFailure(new Error("Installation receipt requires user mode with Edge off, or a system instance; secondary instances must keep Edge off."));
  yield* evaluate(() => validateInstallationPaths({ prefix: value.prefix, instance: value.instance, dataDirectory: value.dataDirectory, configDirectory: value.configDirectory, commandPath: value.commandPath, systemCommandPath: value.commandPath, systemdDirectories: [] }));
  if (value.prefix !== prefix) return yield* new IntegrationFailure(new Error("Installation receipt names another prefix."));
  return value;
});
export function readNativeInstallationReceipt(host: ZelavisInstallHost, prefix: string, instance = "default"): Promise<ZelavisNativeInstallationReceipt | undefined> { return present(readNativeInstallationReceiptProgram(host, prefix, instance)); }

const UNITS = ["zelavis.service", "zelavis.socket", "zelavis-agent.service", "zelavis-host-agent.service", "zelavis-traefik.service", "zelavis-update.service", "zelavis-update.path"] as const;
export const ZELAVIS_INSTALLATION_RETAINED_STATE = [
  "host packages, including shared WordPress dependencies installed with operator approval",
  "systemd journal history",
  "downloaded archives and backups outside the data directory",
  "operator-managed reverse-proxy, firewall, DNS and TLS configuration",
] as const;

function addStep(steps: ZelavisInstallStep[], id: string, description: string, action: ZelavisInstallAction): void {
  const idempotent = !(action.kind === "command" && ["groupadd", "useradd"].includes(action.command));
  steps.push({ id, description, idempotent, action });
}

/** Root publishes Edge output; the unprivileged proxy may only traverse/read it. */
export function planZelavisProductionEdgeDirectories(paths: ZelavisInstallPaths): readonly ZelavisInstallStep[] {
  validateInstallationPaths(paths);
  const scope = installationInstanceScope(paths.prefix, paths.instance);
  if (scope.named) return [];
  const steps: ZelavisInstallStep[] = [];
  for (const path of [`${paths.dataDirectory}/edge`, `${paths.dataDirectory}/edge/traefik`, `${paths.dataDirectory}/edge/traefik/active`]) {
    addStep(steps, `edge:${path}`, `Create the proxy-readable Edge directory ${path}`, { kind: "mkdir", path, mode: 0o750 });
    addStep(steps, `owner:${path}`, `Keep Edge output root-owned and readable by the proxy group`, { kind: "command", command: "chown", args: [`root:${scope.account}`, path] });
  }
  return steps;
}

/** Host unit changes are part of the trusted update transaction, including
 * rollback. The same authored templates serve fresh installs and live updates;
 * refreshing them never restarts the persistent host or Project Agent. */
export const planZelavisRuntimeHostAssetsProgram = Effect.fn("Installation.runtimeHostAssets")(function* (input: {
  readonly host: ZelavisInstallHost; readonly paths: ZelavisInstallPaths; readonly source: string;
  readonly port: number; readonly public?: boolean;
}): Effect.fn.Return<readonly ZelavisInstallStep[], TaggedFailure> {
  const { host, paths, source, port } = input;
  validateInstallationPaths(paths);
  assertInstallationPath(source, "runtime host asset source");
  assertInstallationPort(port);
  const scope = installationInstanceScope(paths.prefix, paths.instance);
  const steps: ZelavisInstallStep[] = [];
  const dataBase = scope.named ? paths.dataDirectory.slice(0, -scope.instance.length - 1) : paths.dataDirectory;
  const configBase = scope.named ? paths.configDirectory.slice(0, -scope.instance.length - 1) : paths.configDirectory;
  const render = (text: string) => text.replaceAll("/opt/zelavis", paths.prefix).replaceAll("/var/lib/zelavis", dataBase).replaceAll("/etc/zelavis", configBase);
  if (!scope.named) {
    // Materialize the selected publication with the selected release's host
    // assets before inventory acknowledgement. JSON is valid YAML, but the
    // Traefik file provider only loads .yml/.yaml/.toml extensions.
    const base = `${paths.dataDirectory}/edge/traefik`;
    const state = yield* integration(() => host.read(`${base}/active-generation.json`));
    if (state) {
      const generation = yield* evaluate(() => JSON.parse(state)?.activeGeneration);
      if (typeof generation !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/u.test(generation)) return yield* new IntegrationFailure(new Error("Invalid active Edge publication generation."));
      const configuration = yield* integration(() => host.read(`${base}/generations/${generation}/traefik-dynamic.json`));
      yield* evaluate(() => {
        const parsed = configuration ? JSON.parse(configuration) : undefined;
        if (!parsed?.http || typeof parsed.http !== "object") throw new Error("Active Edge publication has no HTTP configuration.");
      });
      addStep(steps, "edge-publication", "Materialize the selected Edge publication for the watched provider", { kind: "write", path: `${base}/active/traefik-dynamic.yml`, content: configuration!, mode: 0o644, atomic: true });
    }
  }
  for (const [index, unit] of scope.templates.entries()) {
    const template = (yield* integration(() => host.read(`${source}/share/${unit}`)));
    if (template === undefined && unit === "zelavis-traefik.service") continue;
    if (template === undefined) return yield* new IntegrationFailure(new Error(`Release is missing share/${unit}.`));
    const content = index === 0 && !scope.named ? template.replace("--host 127.0.0.1", `--host ${input.public ? "0.0.0.0" : "127.0.0.1"}`).replace("--port 3000", `--port ${port}`) : template;
    addStep(steps, unit, `Install ${unit} from the release template`, { kind: "write", path: `${paths.systemdDirectories[0]}/${unit}`, content: render(content), mode: 0o644 });
  }
  // systemd holds the listening port across Platform restarts, so an update queues connections instead of refusing them.
  const socketTemplate = (yield* integration(() => host.read(`${source}/share/zelavis.socket`)));
  if (socketTemplate === undefined) return yield* new IntegrationFailure(new Error("Release is missing share/zelavis.socket."));
  addStep(steps, scope.socket, `Install ${scope.socket} from the release template`, { kind: "write", path: `${paths.systemdDirectories[0]}/${scope.socket}`, content: renderSocket(socketTemplate, { host: input.public ? "0.0.0.0" : "127.0.0.1", port, instance: scope.named ? scope.instance : undefined }), mode: 0o644 });
  if (scope.named) {
    // A named instance's update units are the default's, aimed at this instance's request file and name.
    // The updater's ZELAVIS_DATA_DIR stays the base: the installer it runs appends the instance's suffix itself.
    for (const unit of ["zelavis-update.path", "zelavis-update.service"]) {
      const template = (yield* integration(() => host.read(`${source}/share/${unit}`)));
      if (template === undefined) return yield* new IntegrationFailure(new Error(`Release is missing share/${unit}.`));
      const target = unit.endsWith(".path") ? scope.updatePath : scope.updateService;
      const content = template.replaceAll("/opt/zelavis/current", `${paths.prefix}/instances/${scope.instance}/current`).replaceAll("/opt/zelavis", paths.prefix).replace("PathExists=/var/lib/zelavis/", `PathExists=${paths.dataDirectory}/`).replaceAll("zelavis-update.service", scope.updateService).replace("update --run", `update --run --instance ${scope.instance}`).replace("Update the Zelavis Platform", `Update the Zelavis Platform instance ${scope.instance}`);
      addStep(steps, target, `Install ${target} from the release template`, { kind: "write", path: `${paths.systemdDirectories[0]}/${target}`, content, mode: 0o644 });
    }
  }
  return steps;
});

/** The socket unit for an instance: where it listens, and which service it hands connections to. */
function renderSocket(template: string, input: { host: string; port: number; instance?: string }): string {
  const listening = template.replace("ListenStream=127.0.0.1:3000", `ListenStream=${input.host}:${input.port}`);
  // A named instance's service is the template instance, not the socket's own name.
  return input.instance ? listening.replace("[Socket]\n", `[Socket]\nService=zelavis@${input.instance}.service\n`) : listening;
}

function compareInstallationVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([\da-zA-Z.-]+))?(?:\+[\da-zA-Z.-]+)?$/u.exec(value);
    if (!match) throw new Error(`Invalid installation version: ${value}`);
    return { numbers: match.slice(1, 4).map(Number), prerelease: match[4]?.split(".") };
  };
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] - b.numbers[i];
  if (!a.prerelease || !b.prerelease) return a.prerelease ? -1 : b.prerelease ? 1 : 0;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i], y = b.prerelease[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/u.test(x), yn = /^\d+$/u.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export const planZelavisReleaseInstallProgram = Effect.fn("Installation.planZelavisReleaseInstall")(function* (input: {
  readonly host: ZelavisInstallHost;
  readonly source: string;
  readonly paths: ZelavisInstallPaths;
  readonly system: boolean;
  readonly user?: boolean;
  readonly force?: boolean;
  readonly public?: boolean;
  readonly allowDowngrade?: boolean;
  readonly sourceKind?: "release" | "package";
  readonly installedBy?: ZelavisNativeInstallationReceipt["installedBy"];
  readonly stopPlatform?: boolean;
  /** Select through the persistent host, with an inventory acknowledgement. */
  readonly live?: boolean;
  readonly port?: number;
}): Effect.fn.Return<ZelavisHostInstallationPlan, TaggedFailure> {
  const { host, paths, source } = input;
  const scope = installationInstanceScope(paths.prefix, paths.instance);
  const previous = (yield* readNativeInstallationReceiptProgram(host, paths.prefix, scope.instance));
  if (scope.named && !previous && input.port === undefined) return yield* new IntegrationFailure(new Error("A new named instance requires an explicit --port."));
  const port = input.port ?? previous?.port ?? 3000;
  assertInstallationPort(port);
  if (scope.named && input.user) return yield* new IntegrationFailure(new Error("Named instances require system mode."));
  validateInstallationPaths(paths);
  if (input.user && input.system) return yield* new IntegrationFailure(new Error("User installations do not support systemd."));
  assertInstallationPath(source, "release source");
  const manifest = JSON.parse((yield* integration(() => host.read(`${source}/manifest.json`))) ?? "null") as { version?: unknown } | null;
  if (!manifest || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/u.test(manifest.version)) {
    return yield* new IntegrationFailure(new Error("Release manifest must contain a valid version."));
  }
  const version = manifest.version;
  const installedManifest = (yield* integration(() => host.read(`${scope.current}/manifest.json`)));
  if (installedManifest && !input.allowDowngrade) {
    const installed = JSON.parse(installedManifest) as { version: string };
    if (compareInstallationVersions(version, installed.version) < 0) {
      return yield* new IntegrationFailure(new Error(`Refusing downgrade from ${installed.version} to ${version}; use --allow-downgrade deliberately.`));
    }
  }
  const release = `${paths.prefix}/releases/${version}`;
  const warnings: string[] = [];
  const target = (yield* integration(() => host.readlink(paths.commandPath)));
  if ((target !== undefined || (yield* integration(() => host.exists(paths.commandPath)))) && !target?.startsWith(`${paths.prefix}/`)) {
    if (!input.force) return yield* new IntegrationFailure(new Error(`Refusing to replace ${paths.commandPath}, which this installer did not create.\nIt currently resolves to: ${target ?? paths.commandPath}\nRemove it with npm uninstall --global zelavis, or use --force (ZELAVIS_FORCE_BIN=1).`));
    warnings.push(`Replacing ${paths.commandPath} deliberately (--force / ZELAVIS_FORCE_BIN=1).`);
  }
  const resolved = (yield* integration(() => host.which("zelavis", paths.commandPath)));
  if (resolved && resolved !== paths.commandPath) {
    warnings.push(`Warning: 'zelavis' on PATH resolves to ${resolved}, not ${paths.commandPath}. That installation will answer instead of this one. Run 'zelavis --version' to see which one is in use.`);
  }
  const steps: ZelavisInstallStep[] = [];
  if (input.live) {
    if (!previous) return yield* new IntegrationFailure(new Error("Live handover requires an installed persistent Platform host."));
    if (!(yield* integration(() => host.exists(release)))) {
      addStep(steps, "release-directory", "Create the immutable engine catalog directory", { kind: "mkdir", path: `${paths.prefix}/releases`, mode: input.user ? 0o700 : 0o755 });
      addStep(steps, "release", `Copy immutable engine ${version}`, { kind: "copy", source, path: release });
    }
    if (input.system) addStep(steps, "release-owner", "Keep executable engine artifacts owned by root", { kind: "command", command: "chown", args: ["-R", "root:root", release] });
    addStep(steps, "runtime-handover", "Transfer engine ownership and acknowledge root inventory before admitting traffic", {
      kind: "command", command: `${release}/runtime/node/bin/node`,
      args: [`${release}/platform/dist/adapters/_node-runtime-select-cli.js`, paths.prefix, scope.instance, paths.dataDirectory, version],
    });
    return { operation: "install", installation: { kind: "packaged", path: `${release}/platform/dist/cli.js`, root: paths.prefix }, instance: scope.instance, dataDirectory: paths.dataDirectory, steps, warnings, retained: [] };
  }
  let ownsUser = previous?.ownsUser ?? false;
  let ownsGroup = previous?.ownsGroup ?? false;
  const recordOwnership = (id: string) => {
    const receipt: ZelavisNativeInstallationReceipt = { schemaVersion: 2, port, edge: input.system && !scope.named, mode: input.user ? "user" : "system", source: input.sourceKind ?? "release", instance: scope.instance, installedBy: input.installedBy ?? "cli", version, prefix: paths.prefix, configDirectory: paths.configDirectory, dataDirectory: paths.dataDirectory, commandPath: paths.commandPath, ownsUser, ownsGroup };
    addStep(steps, id, "Record installer paths and preserve account ownership (0600)", { kind: "write", path: scope.receipt, content: `${JSON.stringify(receipt, null, 2)}\n`, mode: 0o600, atomic: true });
  };
  if (input.stopPlatform && !input.live) addStep(steps, "platform-stop", "Stop this installation's Platform before taking data ownership", { kind: "command", command: "systemctl", args: ["stop", scope.units[0]] });
  if (!input.user) addStep(steps, "system-prefix", "Keep the shared system prefix traversable by instance accounts", { kind: "mkdir", path: paths.prefix, mode: 0o755 });
  if (scope.named) {
    addStep(steps, "instances-directory", "Keep the shared instance directory traversable", { kind: "mkdir", path: `${paths.prefix}/instances`, mode: 0o755 });
    addStep(steps, "instance-directory", "Create selected instance inventory", { kind: "mkdir", path: scope.directory, mode: 0o755 });
  }
  if (input.user) {
    addStep(steps, "user-prefix", "Create private user installation root", { kind: "mkdir", path: paths.prefix, mode: 0o700 });
    // Record user scope before selecting a runnable command, even if later steps fail.
    recordOwnership("user-mode-receipt");
  }
  for (const path of [`${paths.prefix}/releases`, paths.dataDirectory, paths.commandPath.slice(0, paths.commandPath.lastIndexOf("/"))]) {
    addStep(steps, `directory:${path}`, `Create ${path}`, { kind: "mkdir", path, ...(path === paths.dataDirectory || input.user && path === `${paths.prefix}/releases` ? { mode: 0o700 } : path === `${paths.prefix}/releases` ? { mode: 0o755 } : {}) });
  }
  if (!input.user) recordOwnership("initial-receipt");
  if (!input.live) addStep(steps, "data-reservation", "Reserve the shared Platform data ownership lock for maintenance", { kind: "reserve-data", path: paths.dataDirectory });
  if (!(yield* integration(() => host.exists(release)))) {
    addStep(steps, "release", `Copy staged release ${version} to ${release}`, { kind: "copy", source, path: release });
  }
  if (input.system) addStep(steps, "release-owner", "Keep executable engine artifacts owned by root", { kind: "command", command: "chown", args: ["-R", "root:root", release] });
  addStep(steps, "current", "Select the versioned release", { kind: "link", target: release, path: scope.current, atomic: true });
  if (!scope.named || !(yield* integration(() => host.exists(paths.commandPath)))) addStep(steps, "command", "Link the shared Zelavis command", { kind: "link", target: `${paths.prefix}/current/bin/zelavis`, path: paths.commandPath });
  if (scope.named && !(yield* integration(() => host.exists(`${paths.prefix}/current`)))) addStep(steps, "management-current", "Select initial shared management CLI without altering another instance", { kind: "link", target: release, path: `${paths.prefix}/current`, atomic: true });
  const command = (id: string, description: string, executable: string, args: readonly string[], ignoreFailure = false) =>
    addStep(steps, id, description, { kind: "command", command: executable, args, ignoreFailure });
  if (input.system) {
    if (!(yield* integration(() => host.accountExists("group", scope.account)))) {
      command("group", "Create the dedicated system group", "groupadd", ["--system", scope.account]);
      ownsGroup = true;
      recordOwnership("group-receipt");
    }
    if (!(yield* integration(() => host.accountExists("user", scope.account)))) {
      command("user", "Create the dedicated system user", "useradd", ["--system", "--gid", scope.account, "--home-dir", paths.dataDirectory, "--shell", "/usr/sbin/nologin", scope.account]);
      ownsUser = true;
      recordOwnership("user-receipt");
    }
    addStep(steps, "host-agent-directory", "Create the restricted root Agent directory", { kind: "mkdir", path: `${scope.directory}/host-agent`, mode: 0o750 });
    command("host-agent-owner", "Allow only the dedicated Platform group to connect to the root Agent", "chown", [`root:${scope.account}`, `${scope.directory}/host-agent`]);
    addStep(steps, "host-packages-directory", "Create shared root-owned host package inventory", { kind: "mkdir", path: `${paths.prefix}/host-packages`, mode: 0o700 });
    addStep(steps, "update-directory", "Create the folder the Platform leaves update requests in", { kind: "mkdir", path: `${paths.dataDirectory}/update`, mode: 0o750 });
    if (!input.live) command("data-owner", "Set ownership of Platform data", "chown", ["-R", `${scope.account}:${scope.account}`, paths.dataDirectory]);
    steps.push(...yield* planZelavisRuntimeHostAssetsProgram({ host, paths, source, port, public: input.public }));
    if (!scope.named && (yield* integration(() => host.exists(`${source}/share/zelavis-traefik.service`)))) {
      steps.push(...planZelavisProductionEdgeDirectories(paths));
      for (const path of [`${paths.dataDirectory}/agent`]) {
        addStep(steps, `edge:${path}`, `Create owned directory ${path}`, { kind: "mkdir", path, mode: 0o750 });
        command(`owner:${path}`, `Set ownership of ${path}`, "chown", [`${scope.account}:${scope.account}`, path]);
      }
      addStep(steps, "edge-config-directory", "Create Edge configuration directory", { kind: "mkdir", path: `${paths.configDirectory}/edge/traefik`, mode: 0o755 });
      const config = (yield* integration(() => host.read(`${source}/share/traefik.yml`)));
      if (config === undefined) return yield* new IntegrationFailure(new Error("Release is missing share/traefik.yml."));
      addStep(steps, "edge-config", "Keep existing Traefik configuration", { kind: "write", path: `${paths.configDirectory}/edge/traefik/traefik.yml`, content: config.replaceAll("/var/lib/zelavis", paths.dataDirectory), mode: 0o644, ifAbsent: true });
    }
    addStep(steps, "config-directory", "Create configuration directory", { kind: "mkdir", path: paths.configDirectory, mode: 0o755 });
    addStep(steps, "bootstrap", "Generate first-owner token only when the environment file is absent (0600)", { kind: "bootstrap", path: `${paths.configDirectory}/zelavis.env` });
    addStep(steps, "host-agent-environment", "Configure the separate privileged operation broker", { kind: "agent-environment", path: `${paths.configDirectory}/zelavis.env`, endpoint: `${scope.directory}/host-agent/agent`, variable: "ZELAVIS_HOST_OPERATIONS_ENDPOINT" });
    {
      // Do not expose the existing first-owner token in a plan or dry-run.
      addStep(steps, "agent-environment", "Add Agent endpoint without changing existing environment values", { kind: "agent-environment", path: `${paths.configDirectory}/zelavis.env`, endpoint: `${paths.dataDirectory}/agent` });
    }
    if (!scope.named && !input.live) {
      addStep(steps, "edge-owner", "Reserve host Edge ownership for the default instance", { kind: "claim-edge", prefix: paths.prefix, instance: scope.instance, dataDirectory: paths.dataDirectory });
      command("edge-lock-owner", "Grant the default service group the existing host Edge lock inode", "chown", ["root:zelavis", `${paths.prefix}/.edge-owner.lock`]);
    }
    recordOwnership("receipt");
    if (!input.live) addStep(steps, "data-handover", "Release data ownership before starting the Platform", { kind: "release-data" });
    command("reload", "Reload systemd units", "systemctl", ["daemon-reload"]);
    command("socket-enable", "Hold the dashboard port in systemd", "systemctl", ["enable", "--now", scope.socket]);
    command("agent-enable", "Supervise Project custody separately from the Platform engine", "systemctl", ["enable", "--now", scope.units[1]]);
    // The path unit watches for the Platform's update request and starts the root updater.
    command("update-enable", "Watch for dashboard update requests", "systemctl", ["enable", "--now", scope.updatePath]);
    command("host-agent-enable", "Enable the restricted root operation Agent", "systemctl", ["enable", "--now", scope.units[scope.units.length - 1]]);
    if (previous || installedManifest) command("host-agent-restart", "Load the updated operation manifests", "systemctl", ["restart", scope.units[scope.units.length - 1]]);
    command("platform-enable", "Enable and start the Platform", "systemctl", ["enable", "--now", scope.units[0]]);
    if (previous || installedManifest && JSON.parse(installedManifest).version !== version) {
      command("platform-restart", "Restart the Platform on the newly selected release", "systemctl", ["restart", scope.units[0]]);
    }
    if (!scope.named) command("edge-enable", "Enable production ingress; the Platform publishes and activates its default route", "systemctl", ["enable", "zelavis-traefik.service"]);
  }
  if (input.user) {
    addStep(steps, "config-directory", "Create private user configuration", { kind: "mkdir", path: paths.configDirectory, mode: 0o700 });
    addStep(steps, "bootstrap", "Generate first-owner token and record user data location (0600)", { kind: "bootstrap", path: `${paths.configDirectory}/zelavis.env`, dataDirectory: paths.dataDirectory, public: input.public });
  }
  if (!input.system) recordOwnership("receipt");
  const runtime = { schemaVersion: 1, version, instance: scope.instance, prefix: paths.prefix, dataDirectory: paths.dataDirectory, configDirectory: paths.configDirectory, port, host: input.public ? "0.0.0.0" : "127.0.0.1", edge: input.system && !scope.named };
  // This descriptor contains no token and must exist before systemd startup.
  const runtimeStep: ZelavisInstallStep = { id: "runtime-descriptor", description: "Record public runtime selection without bootstrap secrets", idempotent: true, action: { kind: "write", path: scope.runtime, content: `${JSON.stringify(runtime)}\n`, mode: input.user ? 0o600 : 0o644, atomic: true } };
  const handover = steps.findIndex((step) => step.id === "data-handover");
  steps.splice(handover < 0 ? steps.length : handover, 0, runtimeStep);
  return { operation: "install", installation: { kind: "packaged", path: `${release}/platform/dist/cli.js`, root: paths.prefix }, instance: scope.instance, dataDirectory: paths.dataDirectory, steps, warnings, retained: [] };
});
export function planZelavisReleaseInstall(input: Parameters<typeof planZelavisReleaseInstallProgram>[0]): Promise<ZelavisHostInstallationPlan> { return present(planZelavisReleaseInstallProgram(input)); }

export function planZelavisUninstall(input: {
  readonly paths: ZelavisInstallPaths;
  readonly hostCommands: boolean;
  readonly user?: boolean;
  readonly ownsUser: boolean;
  readonly ownsGroup: boolean;
  readonly retainShared?: boolean;
  readonly additionalCommandPaths?: readonly string[];
}): ZelavisHostInstallationPlan {
  const { paths } = input;
  const scope = installationInstanceScope(paths.prefix, paths.instance);
  validateInstallationPaths(paths);
  const steps: ZelavisInstallStep[] = [];
  const command = (id: string, args: readonly string[]) => addStep(steps, id, `systemctl ${args.join(" ")}`, { kind: "command", command: "systemctl", args, ignoreFailure: true });
  if (input.user && input.hostCommands) throw new Error("User uninstall must not execute system maintenance commands.");
  if (input.hostCommands) {
    command("stop", ["stop", scope.socket, ...scope.units]);
    command("disable", ["disable", scope.socket, ...scope.units]);
    addStep(steps, "data-reservation", "Reserve Platform data after stopping the owned units", { kind: "reserve-data", path: paths.dataDirectory });
  }
  if (!input.hostCommands) addStep(steps, "data-reservation", "Refuse removal while a Platform owns these data", { kind: "reserve-data", path: paths.dataDirectory });
  if (!input.user && !scope.named) addStep(steps, "edge-release", `Release ${paths.prefix}/edge-owner.json and ${paths.prefix}/.edge-owner.lock only when owned by this instance`, { kind: "release-edge", prefix: paths.prefix, instance: scope.instance, dataDirectory: paths.dataDirectory });
  if (input.hostCommands && !input.retainShared) addStep(steps, "package-policy", "Restore only the recorded host package policy; preserve operator changes", { kind: "restore-package-policy", stateDirectory: `${paths.prefix}/host-packages`, policy: "/usr/sbin/policy-rc.d" });
  if (input.hostCommands && !input.retainShared) addStep(steps, "packages", "Purge zelavis when installed through dpkg", { kind: "purge-packages" });
  for (const path of new Set(input.retainShared ? [] : input.user ? [paths.commandPath] : [paths.commandPath, paths.systemCommandPath, ...input.additionalCommandPaths ?? []])) {
    assertInstallationPath(path, "command", "zelavis");
    addStep(steps, `command:${path}`, `Remove only a Zelavis-owned command link at ${path}`, { kind: "remove-link", path, prefix: paths.prefix });
  }
  const removalPaths = new Set<string>();
  const remove = (path: string, recursive = false) => { if (!removalPaths.has(path)) { removalPaths.add(path); addStep(steps, `remove:${path}`, `Remove ${path}`, { kind: "remove", path, recursive }); } };
  if (!input.user) {
    for (const unit of [...scope.units, scope.socket]) {
      for (const directory of paths.systemdDirectories) remove(`${directory}/${unit}`);
      remove(`${paths.systemdDirectories[0]}/multi-user.target.wants/${unit}`);
      remove(`${paths.systemdDirectories[0]}/sockets.target.wants/${unit}`);
      remove(`${paths.systemdDirectories[0]}/${unit}.d`, true);
    }
    if (!input.retainShared) {
      for (const template of ["zelavis@.service", "zelavis-agent@.service", "zelavis-host-agent@.service", ...UNITS]) for (const directory of paths.systemdDirectories) remove(`${directory}/${template}`);
    }
  }
  remove(paths.configDirectory, true);
  // Keep both ownership inodes until every other host mutation has completed.
  if (input.hostCommands) {
    addStep(steps, "account", "Remove only recorded installer-created accounts with safe current properties", { kind: "remove-account", account: scope.account, dataDirectory: paths.dataDirectory, ownsUser: input.ownsUser, ownsGroup: input.ownsGroup });
    command("reload", ["daemon-reload"]);
    command("reset", ["reset-failed", ...scope.units]);
  }
  addStep(steps, `remove:${paths.dataDirectory}`, `Remove ${paths.dataDirectory}, including runtime custody, control socket, engine journals/ownership locks, Agent state and every Project`, { kind: "remove", path: paths.dataDirectory, recursive: true });
  if (input.retainShared) {
    if (scope.named) remove(scope.directory, true);
    else { remove(scope.receipt); remove(scope.runtime); remove(`${scope.directory}/host-agent`, true); }
  } else addStep(steps, `remove:${paths.prefix}`, `Remove ${paths.prefix}, including installer lock, receipt and all releases`, { kind: "remove", path: paths.prefix, recursive: true });
  return { operation: "uninstall", installation: { kind: "packaged", path: `${paths.prefix}/current/platform/dist/cli.js`, root: paths.prefix }, instance: scope.instance, dataDirectory: paths.dataDirectory, steps, warnings: [], retained: [...ZELAVIS_INSTALLATION_RETAINED_STATE, ...(input.retainShared ? ["Shared release tree, management command, package records and unit templates required by other instances"] : [])] };
}

export const executeZelavisInstallationPlanProgram = Effect.fn("Installation.executeZelavisInstallationPlan")(function* (host: ZelavisInstallHost, plan: ZelavisHostInstallationPlan, confirmation?: string): Effect.fn.Return<readonly string[], TaggedFailure> {
  if (plan.operation === "uninstall") yield* evaluate(() => assertCompleteUninstallConfirmation(confirmation ?? ""));
  const output: string[] = [];
  return yield* Effect.gen(function* () {
    for (const step of plan.steps) {
      const result = (yield* integration(() => host.execute(step.action)));
      if (result) output.push(result);
    }
    return output;
  }).pipe(Effect.ensuring(integration(() => host.releaseMaintenance?.()).pipe(Effect.orDie)));
});
export function executeZelavisInstallationPlan(host: ZelavisInstallHost, plan: ZelavisHostInstallationPlan, confirmation?: string): Promise<readonly string[]> { return present(executeZelavisInstallationPlanProgram(host, plan, confirmation)); }
