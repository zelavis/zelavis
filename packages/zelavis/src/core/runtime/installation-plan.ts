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
  | { readonly kind: "bootstrap"; readonly path: string }
  | { readonly kind: "agent-environment"; readonly path: string; readonly endpoint: string }
  | { readonly kind: "command"; readonly command: string; readonly args: readonly string[]; readonly ignoreFailure?: boolean }
  | { readonly kind: "remove"; readonly path: string; readonly recursive?: boolean }
  | { readonly kind: "remove-link"; readonly path: string; readonly prefix: string }
  | { readonly kind: "purge-packages" }
  | { readonly kind: "remove-account"; readonly dataDirectory: string; readonly ownsUser: boolean; readonly ownsGroup: boolean };

export interface ZelavisInstallStep {
  readonly id: string;
  readonly description: string;
  readonly idempotent: boolean;
  readonly action: ZelavisInstallAction;
}

export interface ZelavisHostInstallationPlan {
  readonly operation: "install" | "uninstall";
  readonly installation: ZelavisInstallationIdentity;
  /** Named instances are reserved; only default is implemented. */
  readonly instance: "default";
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
  execute(action: ZelavisInstallAction): Promise<string | undefined>;
}

export interface ZelavisInstallPaths {
  readonly prefix: string;
  readonly dataDirectory: string;
  readonly configDirectory: string;
  readonly commandPath: string;
  readonly systemCommandPath: string;
  readonly systemdDirectories: readonly string[];
  readonly aptSource: string;
  readonly aptKeyring: string;
}

const UNSAFE_ROOTS = new Set("/ /Applications /Library /System /Users /bin /dev /etc /home /lib /media /mnt /opt /private /proc /root /run /sbin /srv /sys /tmp /usr /var".split(" "));

export function assertInstallationPath(path: string, label: string, name?: string): void {
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
  assertInstallationPath(paths.prefix, "installation root");
  assertInstallationPath(paths.dataDirectory, "data directory");
  assertInstallationPath(paths.configDirectory, "configuration directory");
  for (const path of paths.systemdDirectories) assertInstallationPath(path, "systemd directory");
  assertInstallationPath(paths.commandPath, "command", "zelavis");
  assertInstallationPath(paths.systemCommandPath, "system command", "zelavis");
  assertInstallationPath(paths.aptSource, "APT source", "zelavis.sources");
  assertInstallationPath(paths.aptKeyring, "APT keyring", "zelavis-archive-keyring.gpg");
}

export interface ZelavisNativeInstallationReceipt {
  readonly schemaVersion: 1;
  readonly dataDirectory: string;
  readonly commandPath: string;
  readonly ownsUser: boolean;
  readonly ownsGroup: boolean;
}

export async function readNativeInstallationReceipt(host: ZelavisInstallHost, prefix: string): Promise<ZelavisNativeInstallationReceipt | undefined> {
  const content = await host.read(`${prefix}/installation.json`);
  if (content === undefined) return undefined;
  const value = JSON.parse(content) as ZelavisNativeInstallationReceipt;
  if (!value || value.schemaVersion !== 1 || typeof value.dataDirectory !== "string" ||
      typeof value.commandPath !== "string" || typeof value.ownsUser !== "boolean" || typeof value.ownsGroup !== "boolean") {
    throw new Error(`Native installation receipt at ${prefix}/installation.json is malformed.`);
  }
  return value;
}

const UNITS = ["zelavis.service", "zelavis-agent.service", "zelavis-traefik.service"] as const;
export const ZELAVIS_INSTALLATION_RETAINED_STATE = [
  "nginx, PHP, MariaDB and other shared host packages",
  "systemd journal history",
  "downloaded archives and backups outside the data directory",
  "operator-managed reverse-proxy, firewall, DNS and TLS configuration",
] as const;

function addStep(steps: ZelavisInstallStep[], id: string, description: string, action: ZelavisInstallAction): void {
  const idempotent = !(action.kind === "command" && ["groupadd", "useradd"].includes(action.command));
  steps.push({ id, description, idempotent, action });
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

export async function planZelavisReleaseInstall(input: {
  readonly host: ZelavisInstallHost;
  readonly source: string;
  readonly paths: ZelavisInstallPaths;
  readonly system: boolean;
  readonly force?: boolean;
  readonly enableAgent?: boolean;
  readonly public?: boolean;
  readonly allowDowngrade?: boolean;
}): Promise<ZelavisHostInstallationPlan> {
  const { host, paths, source } = input;
  validateInstallationPaths(paths);
  assertInstallationPath(source, "release source");
  const manifest = JSON.parse(await host.read(`${source}/manifest.json`) ?? "null") as { version?: unknown } | null;
  if (!manifest || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/u.test(manifest.version)) {
    throw new Error("Release manifest must contain a valid version.");
  }
  const version = manifest.version;
  const installedManifest = await host.read(`${paths.prefix}/current/manifest.json`);
  if (installedManifest && !input.allowDowngrade) {
    const installed = JSON.parse(installedManifest) as { version: string };
    if (compareInstallationVersions(version, installed.version) < 0) {
      throw new Error(`Refusing downgrade from ${installed.version} to ${version}; use --allow-downgrade deliberately.`);
    }
  }
  const release = `${paths.prefix}/releases/${version}`;
  const previous = await readNativeInstallationReceipt(host, paths.prefix);
  const warnings: string[] = [];
  const target = await host.readlink(paths.commandPath);
  if ((target !== undefined || await host.exists(paths.commandPath)) && !target?.startsWith(`${paths.prefix}/`)) {
    if (!input.force) throw new Error(`Refusing to replace ${paths.commandPath}, which this installer did not create.\nIt currently resolves to: ${target ?? paths.commandPath}\nRemove it with npm uninstall --global zelavis, or use --force (ZELAVIS_FORCE_BIN=1).`);
    warnings.push(`Replacing ${paths.commandPath} deliberately (--force / ZELAVIS_FORCE_BIN=1).`);
  }
  const resolved = await host.which("zelavis", paths.commandPath);
  if (resolved && resolved !== paths.commandPath) {
    warnings.push(`Warning: 'zelavis' on PATH resolves to ${resolved}, not ${paths.commandPath}. That installation will answer instead of this one. Run 'zelavis --version' to see which one is in use.`);
  }
  const steps: ZelavisInstallStep[] = [];
  for (const path of [`${paths.prefix}/releases`, paths.dataDirectory, paths.commandPath.slice(0, paths.commandPath.lastIndexOf("/"))]) {
    addStep(steps, `directory:${path}`, `Create ${path}`, { kind: "mkdir", path });
  }
  if (!await host.exists(release)) {
    addStep(steps, "release", `Copy staged release ${version} to ${release}`, { kind: "copy", source, path: release });
  }
  addStep(steps, "current", "Select the versioned release", { kind: "link", target: release, path: `${paths.prefix}/current`, atomic: true });
  addStep(steps, "command", "Link the Zelavis command", { kind: "link", target: `${paths.prefix}/current/bin/zelavis`, path: paths.commandPath });
  let ownsUser = previous?.ownsUser ?? false;
  let ownsGroup = previous?.ownsGroup ?? false;
  const recordOwnership = (id: string) => {
    const receipt: ZelavisNativeInstallationReceipt = { schemaVersion: 1, dataDirectory: paths.dataDirectory, commandPath: paths.commandPath, ownsUser, ownsGroup };
    addStep(steps, id, "Record installer paths and preserve account ownership (0600)", { kind: "write", path: `${paths.prefix}/installation.json`, content: `${JSON.stringify(receipt, null, 2)}\n`, mode: 0o600, atomic: true });
  };
  const command = (id: string, description: string, executable: string, args: readonly string[], ignoreFailure = false) =>
    addStep(steps, id, description, { kind: "command", command: executable, args, ignoreFailure });
  if (input.system) {
    if (!await host.accountExists("group", "zelavis")) {
      command("group", "Create the dedicated system group", "groupadd", ["--system", "zelavis"]);
      ownsGroup = true;
      recordOwnership("group-receipt");
    }
    if (!await host.accountExists("user", "zelavis")) {
      command("user", "Create the dedicated system user", "useradd", ["--system", "--gid", "zelavis", "--home-dir", paths.dataDirectory, "--shell", "/usr/sbin/nologin", "zelavis"]);
      ownsUser = true;
      recordOwnership("user-receipt");
    }
    command("data-owner", "Set ownership of Platform data", "chown", ["-R", "zelavis:zelavis", paths.dataDirectory]);
    const render = (text: string) => text.replaceAll("/opt/zelavis/current", `${paths.prefix}/current`).replaceAll("/var/lib/zelavis", paths.dataDirectory).replaceAll("/etc/zelavis", paths.configDirectory);
    for (const unit of UNITS) {
      const template = await host.read(`${source}/share/${unit}`);
      if (template === undefined && unit === "zelavis-traefik.service") continue;
      if (template === undefined) throw new Error(`Release is missing share/${unit}.`);
      const content = input.public && unit === "zelavis.service" ? template.replace("--host 127.0.0.1", "--host 0.0.0.0") : template;
      addStep(steps, unit, `Install ${unit} from the release template`, { kind: "write", path: `${paths.systemdDirectories[0]}/${unit}`, content: render(content), mode: 0o644 });
    }
    if (await host.exists(`${source}/share/zelavis-traefik.service`)) {
      for (const path of [`${paths.dataDirectory}/edge/traefik/active`, `${paths.dataDirectory}/agent`]) {
        addStep(steps, `edge:${path}`, `Create owned directory ${path}`, { kind: "mkdir", path, mode: 0o750 });
        command(`owner:${path}`, `Set ownership of ${path}`, "chown", ["zelavis:zelavis", path]);
      }
      addStep(steps, "edge-config-directory", "Create Edge configuration directory", { kind: "mkdir", path: `${paths.configDirectory}/edge/traefik`, mode: 0o755 });
      const config = await host.read(`${source}/share/traefik.yml`);
      if (config === undefined) throw new Error("Release is missing share/traefik.yml.");
      addStep(steps, "edge-config", "Keep existing Traefik configuration", { kind: "write", path: `${paths.configDirectory}/edge/traefik/traefik.yml`, content: render(config), mode: 0o644, ifAbsent: true });
    }
    addStep(steps, "config-directory", "Create configuration directory", { kind: "mkdir", path: paths.configDirectory, mode: 0o755 });
    const trust = await host.read(`${source}/share/operation-trust.json`);
    if (trust === undefined) throw new Error("Release is missing share/operation-trust.json.");
    addStep(steps, "trust", "Install trust store only when absent", { kind: "write", path: `${paths.configDirectory}/operation-trust.json`, content: trust, mode: 0o644, ifAbsent: true });
    addStep(steps, "bootstrap", "Generate first-owner token only when the environment file is absent (0600)", { kind: "bootstrap", path: `${paths.configDirectory}/zelavis.env` });
    if (input.enableAgent) {
      // Do not expose the existing first-owner token in a plan or dry-run.
      addStep(steps, "agent-environment", "Add Agent endpoint without changing existing environment values", { kind: "agent-environment", path: `${paths.configDirectory}/zelavis.env`, endpoint: `${paths.dataDirectory}/agent` });
    }
    command("reload", "Reload systemd units", "systemctl", ["daemon-reload"]);
    if (input.enableAgent) command("agent-enable", "Enable and start the opted-in Agent", "systemctl", ["enable", "--now", "zelavis-agent.service"]);
    command("platform-enable", "Enable and start the Platform", "systemctl", ["enable", "--now", "zelavis.service"]);
    if (previous || installedManifest && JSON.parse(installedManifest).version !== version) {
      command("platform-restart", "Restart the Platform on the newly selected release", "systemctl", ["restart", "zelavis.service"]);
    }
    command("edge-disable", "Leave Traefik disabled until Edge publishes routes", "systemctl", ["disable", "zelavis-traefik.service"], true);
  }
  recordOwnership("receipt");
  return { operation: "install", installation: { kind: "packaged", path: `${release}/platform/dist/cli.js`, root: paths.prefix }, instance: "default", dataDirectory: paths.dataDirectory, steps, warnings, retained: [] };
}

export function planZelavisUninstall(input: {
  readonly paths: ZelavisInstallPaths;
  readonly hostCommands: boolean;
  readonly ownsUser: boolean;
  readonly ownsGroup: boolean;
  readonly additionalCommandPaths?: readonly string[];
}): ZelavisHostInstallationPlan {
  const { paths } = input;
  validateInstallationPaths(paths);
  const steps: ZelavisInstallStep[] = [];
  const command = (id: string, args: readonly string[]) => addStep(steps, id, `systemctl ${args.join(" ")}`, { kind: "command", command: "systemctl", args, ignoreFailure: true });
  if (input.hostCommands) {
    command("stop", ["stop", ...UNITS]);
    command("disable", ["disable", ...UNITS]);
    addStep(steps, "packages", "Purge zelavis and zelavis-repository when installed through dpkg", { kind: "purge-packages" });
  }
  for (const path of new Set([paths.commandPath, paths.systemCommandPath, ...input.additionalCommandPaths ?? []])) {
    assertInstallationPath(path, "command", "zelavis");
    addStep(steps, `command:${path}`, `Remove only a Zelavis-owned command link at ${path}`, { kind: "remove-link", path, prefix: paths.prefix });
  }
  const remove = (path: string, recursive = false) => addStep(steps, `remove:${path}`, `Remove ${path}`, { kind: "remove", path, recursive });
  for (const unit of UNITS) {
    for (const directory of paths.systemdDirectories) remove(`${directory}/${unit}`);
    remove(`${paths.systemdDirectories[0]}/multi-user.target.wants/${unit}`);
    remove(`${paths.systemdDirectories[0]}/${unit}.d`, true);
  }
  remove(paths.aptSource);
  remove(paths.aptKeyring);
  remove(paths.configDirectory, true);
  remove(paths.dataDirectory, true);
  remove(paths.prefix, true);
  if (input.hostCommands) {
    addStep(steps, "account", "Remove only recorded installer-created accounts with safe current properties", { kind: "remove-account", dataDirectory: paths.dataDirectory, ownsUser: input.ownsUser, ownsGroup: input.ownsGroup });
    command("reload", ["daemon-reload"]);
    command("reset", ["reset-failed", ...UNITS]);
  }
  return { operation: "uninstall", installation: { kind: "packaged", path: `${paths.prefix}/current/platform/dist/cli.js`, root: paths.prefix }, instance: "default", dataDirectory: paths.dataDirectory, steps, warnings: [], retained: ZELAVIS_INSTALLATION_RETAINED_STATE };
}

export async function executeZelavisInstallationPlan(host: ZelavisInstallHost, plan: ZelavisHostInstallationPlan, confirmation?: string): Promise<readonly string[]> {
  if (plan.operation === "uninstall") assertCompleteUninstallConfirmation(confirmation ?? "");
  const output: string[] = [];
  for (const step of plan.steps) {
    const result = await host.execute(step.action);
    if (result) output.push(result);
  }
  return output;
}
