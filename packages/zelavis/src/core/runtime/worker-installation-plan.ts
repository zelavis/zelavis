import { Effect } from "effect";
import { isBoolean, isString, literal, objectFields, optional, parseJson } from "../json-validation.js";
import { evaluate, integration, IntegrationFailure, present, type TaggedFailure } from "./effect-boundary.js";
import {
  ZELAVIS_INSTALLATION_RETAINED_STATE,
  assertInstallationPath,
  compareInstallationVersions,
  readInstallationRoleProgram,
  type ZelavisHostInstallationPlan,
  type ZelavisInstallAction,
  type ZelavisInstallHost,
  type ZelavisInstallStep,
  type ZelavisWorkerReceipt,
} from "./installation-plan.js";

/**
 * The worker role: a machine that runs the Projects a Platform places on it.
 *
 * A worker is a Platform's counterpart, not a second Platform: it has no
 * dashboard, no Edge, no System Store, no update socket and no Agent for host
 * operations. It is the release tree, one dedicated account, and one unit
 * running `zelavis agent --remote-project-config`. It shares the installation
 * receipt (`<prefix>/installation.json`) with the Platform role, told apart by
 * `role`, so a machine is one or the other by construction and every reader
 * and remover chooses by role first.
 *
 * Authority and invariants:
 * - The plan is data over the host's existing actions; it carries no token and
 *   no host code. Enrolling is `zelavis worker join`, run by the worker's own
 *   account, so the Agent's key is created and owned by the account that uses
 *   it and the enrollment credential never appears in a plan or a dry run.
 * - The receipt is written before anything else is created and again as
 *   ownership is learned, so an installation that fails half way can still be
 *   removed completely.
 * - Only what the installer created is removed: an account is removed only when
 *   the receipt says the installer made it and its current properties still say
 *   so, and a command link only when it points into this prefix.
 */

export const WORKER_ACCOUNT = "zelavis-worker";
export const WORKER_UNITS = ["zelavis-worker.path", "zelavis-worker.service"] as const;
/** Where `zelavis worker join` leaves the Agent's configuration, relative to the data directory. */
export const WORKER_CONFIG_FILE = "worker/remote-project.json";

export interface ZelavisWorkerInstallPaths {
  readonly prefix: string;
  readonly dataDirectory: string;
  readonly commandPath: string;
  readonly systemCommandPath: string;
  readonly systemdDirectories: readonly string[];
}

/** The one receipt file both roles use. */
export const installationReceiptPath = (prefix: string): string => `${prefix}/installation.json`;

const VERSION = /^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/u;

export function validateWorkerInstallPaths(paths: ZelavisWorkerInstallPaths): void {
  assertInstallationPath(paths.prefix, "installation root");
  assertInstallationPath(paths.dataDirectory, "worker data directory");
  assertInstallationPath(paths.commandPath, "command", "zelavis");
  assertInstallationPath(paths.systemCommandPath, "system command", "zelavis");
  if (paths.dataDirectory === paths.prefix || paths.dataDirectory.startsWith(`${paths.prefix}/`) || paths.prefix.startsWith(`${paths.dataDirectory}/`)) {
    throw new Error("The worker data directory and the installation root must be separate.");
  }
  for (const path of paths.systemdDirectories) assertInstallationPath(path, "systemd directory");
}

const receiptRecord = objectFields<ZelavisWorkerReceipt>({
  schemaVersion: literal(3), role: literal("worker"), version: isString, installedBy: literal("script", "create", "cli"),
  prefix: isString, dataDirectory: isString, commandPath: isString, account: isString,
  ownsUser: isBoolean, ownsGroup: isBoolean,
});

export const readWorkerReceiptProgram = Effect.fn("WorkerInstallation.readReceipt")(function* (
  host: ZelavisInstallHost,
  prefix: string,
): Effect.fn.Return<ZelavisWorkerReceipt | undefined, TaggedFailure> {
  const role = yield* readInstallationRoleProgram(host, prefix);
  if (role === undefined) return undefined;
  if (role === "platform") {
    return yield* new IntegrationFailure(new Error("A Zelavis Platform is installed here, and a machine is either a Platform or a worker. Remove the Platform first, or use another machine."));
  }
  const file = installationReceiptPath(prefix);
  const content = (yield* integration(() => host.read(file)))!;
  const value = yield* evaluate(() => parseJson(content, receiptRecord, `Worker installation receipt at ${file}`));
  if (!VERSION.test(value.version) || value.prefix !== prefix || value.account !== WORKER_ACCOUNT) {
    return yield* new IntegrationFailure(new Error(`Worker installation receipt at ${file} is malformed.`));
  }
  yield* evaluate(() => validateWorkerInstallPaths({
    prefix: value.prefix, dataDirectory: value.dataDirectory, commandPath: value.commandPath,
    systemCommandPath: value.commandPath, systemdDirectories: [],
  }));
  return value;
});
export function readWorkerReceipt(host: ZelavisInstallHost, prefix: string): Promise<ZelavisWorkerReceipt | undefined> {
  return present(readWorkerReceiptProgram(host, prefix));
}

function addStep(steps: ZelavisInstallStep[], id: string, description: string, action: ZelavisInstallAction): void {
  steps.push({ id, description, idempotent: !(action.kind === "command" && ["groupadd", "useradd"].includes(action.command)), action });
}

/** Unit templates name the default paths; a host with other paths gets them rewritten. */
const renderUnit = (template: string, paths: ZelavisWorkerInstallPaths): string =>
  template.replaceAll("/var/lib/zelavis-worker", paths.dataDirectory).replaceAll("/opt/zelavis", paths.prefix);

export const planZelavisWorkerInstallProgram = Effect.fn("WorkerInstallation.plan")(function* (input: {
  readonly host: ZelavisInstallHost;
  readonly source: string;
  readonly paths: ZelavisWorkerInstallPaths;
  readonly force?: boolean;
  readonly allowDowngrade?: boolean;
  readonly installedBy?: ZelavisWorkerReceipt["installedBy"];
}): Effect.fn.Return<ZelavisHostInstallationPlan, TaggedFailure> {
  const { host, paths, source } = input;
  yield* evaluate(() => validateWorkerInstallPaths(paths));
  yield* evaluate(() => assertInstallationPath(source, "release source"));
  // A Platform's receipt makes this read fail: a machine is a Platform or a worker, never both.
  const previous = yield* readWorkerReceiptProgram(host, paths.prefix);
  if (previous && previous.dataDirectory !== paths.dataDirectory) {
    return yield* new IntegrationFailure(new Error(`This worker keeps its data in ${previous.dataDirectory}; refusing to move it to ${paths.dataDirectory}.`));
  }

  const manifest = parseJson(
    (yield* integration(() => host.read(`${source}/manifest.json`))) ?? "null",
    (value): value is { version?: string } | null => value === null || objectFields<{ version?: string }>({ version: optional(isString) })(value),
  );
  if (!manifest || typeof manifest.version !== "string" || !VERSION.test(manifest.version)) {
    return yield* new IntegrationFailure(new Error("Release manifest must contain a valid version."));
  }
  const version = manifest.version;
  if (previous && !input.allowDowngrade && compareInstallationVersions(version, previous.version) < 0) {
    return yield* new IntegrationFailure(new Error(`Refusing downgrade from ${previous.version} to ${version}; use --allow-downgrade deliberately.`));
  }

  const release = `${paths.prefix}/releases/${version}`;
  const warnings: string[] = [];
  const target = yield* integration(() => host.readlink(paths.commandPath));
  if ((target !== undefined || (yield* integration(() => host.exists(paths.commandPath)))) && !target?.startsWith(`${paths.prefix}/`)) {
    if (!input.force) {
      return yield* new IntegrationFailure(new Error(`Refusing to replace ${paths.commandPath}, which this installer did not create.\nIt currently resolves to: ${target ?? paths.commandPath}\nRemove it, or use --force.`));
    }
    warnings.push(`Replacing ${paths.commandPath} deliberately (--force).`);
  }

  const templates: Record<string, string> = {};
  for (const unit of WORKER_UNITS) {
    const template = yield* integration(() => host.read(`${source}/share/${unit}`));
    if (template === undefined) return yield* new IntegrationFailure(new Error(`Release is missing share/${unit}.`));
    templates[unit] = template;
  }

  let ownsUser = previous?.ownsUser ?? false;
  let ownsGroup = previous?.ownsGroup ?? false;
  const steps: ZelavisInstallStep[] = [];
  const command = (id: string, description: string, executable: string, args: readonly string[], ignoreFailure = false) =>
    addStep(steps, id, description, { kind: "command", command: executable, args, ignoreFailure });
  const recordOwnership = (id: string) => {
    const receipt: ZelavisWorkerReceipt = {
      schemaVersion: 3, role: "worker", version, installedBy: input.installedBy ?? "cli", prefix: paths.prefix,
      dataDirectory: paths.dataDirectory, commandPath: paths.commandPath, account: WORKER_ACCOUNT, ownsUser, ownsGroup,
    };
    addStep(steps, id, "Record installer paths and account ownership (0600)", { kind: "write", path: installationReceiptPath(paths.prefix), content: `${JSON.stringify(receipt, null, 2)}\n`, mode: 0o600, atomic: true });
  };

  addStep(steps, "system-prefix", "Keep the installation root traversable by the worker account", { kind: "mkdir", path: paths.prefix, mode: 0o755 });
  addStep(steps, "release-directory", "Create the release catalog directory", { kind: "mkdir", path: `${paths.prefix}/releases`, mode: 0o755 });
  addStep(steps, "data-directory", "Create the worker data directory (private)", { kind: "mkdir", path: paths.dataDirectory, mode: 0o700 });
  addStep(steps, "command-directory", "Create the command directory", { kind: "mkdir", path: paths.commandPath.slice(0, paths.commandPath.lastIndexOf("/")) });
  // Written before anything else exists, so a failure part way is still removable.
  recordOwnership("initial-receipt");

  if (!(yield* integration(() => host.exists(release)))) {
    addStep(steps, "release", `Copy staged release ${version} to ${release}`, { kind: "copy", source, path: release });
  }
  command("release-owner", "Keep executable engine artifacts owned by root", "chown", ["-R", "root:root", release]);
  addStep(steps, "current", "Select the versioned release", { kind: "link", target: release, path: `${paths.prefix}/current`, atomic: true });
  addStep(steps, "command", "Link the Zelavis command", { kind: "link", target: `${paths.prefix}/current/bin/zelavis`, path: paths.commandPath });

  if (!(yield* integration(() => host.accountExists("group", WORKER_ACCOUNT)))) {
    command("group", "Create the dedicated worker group", "groupadd", ["--system", WORKER_ACCOUNT]);
    ownsGroup = true;
    recordOwnership("group-receipt");
  }
  if (!(yield* integration(() => host.accountExists("user", WORKER_ACCOUNT)))) {
    command("user", "Create the dedicated worker user", "useradd", ["--system", "--gid", WORKER_ACCOUNT, "--home-dir", paths.dataDirectory, "--shell", "/usr/sbin/nologin", WORKER_ACCOUNT]);
    ownsUser = true;
    recordOwnership("user-receipt");
  }
  command("data-owner", "Give the worker account its data directory", "chown", ["-R", `${WORKER_ACCOUNT}:${WORKER_ACCOUNT}`, paths.dataDirectory]);

  for (const unit of WORKER_UNITS) {
    addStep(steps, unit, `Install ${unit} from the release template`, { kind: "write", path: `${paths.systemdDirectories[0]}/${unit}`, content: renderUnit(templates[unit]!, paths), mode: 0o644 });
  }
  recordOwnership("receipt");

  command("reload", "Reload systemd units", "systemctl", ["daemon-reload"]);
  command("path-enable", "Start the worker Agent automatically once it has joined a Platform", "systemctl", ["enable", "--now", "zelavis-worker.path"]);
  // An update swaps the release under a running Agent. A machine that has not joined has nothing to restart.
  if (previous) command("worker-restart", "Restart a running worker Agent on the newly selected release", "systemctl", ["try-restart", "zelavis-worker.service"], true);

  return {
    operation: "install",
    installation: { kind: "packaged", path: `${release}/platform/dist/cli.js`, root: paths.prefix },
    instance: "worker",
    dataDirectory: paths.dataDirectory,
    steps, warnings, retained: [],
  };
});
export function planZelavisWorkerInstall(input: Parameters<typeof planZelavisWorkerInstallProgram>[0]): Promise<ZelavisHostInstallationPlan> {
  return present(planZelavisWorkerInstallProgram(input));
}

/** Everything the worker installer owns, and nothing it does not. */
export function planZelavisWorkerUninstall(input: {
  readonly paths: ZelavisWorkerInstallPaths;
  readonly receipt: ZelavisWorkerReceipt;
  readonly hostCommands: boolean;
}): ZelavisHostInstallationPlan {
  const { paths, receipt } = input;
  validateWorkerInstallPaths(paths);
  const steps: ZelavisInstallStep[] = [];
  const systemctl = (id: string, args: readonly string[]) => addStep(steps, id, `systemctl ${args.join(" ")}`, { kind: "command", command: "systemctl", args, ignoreFailure: true });
  if (input.hostCommands) {
    systemctl("stop", ["stop", ...WORKER_UNITS]);
    systemctl("disable", ["disable", ...WORKER_UNITS]);
  }
  for (const path of new Set([paths.commandPath, paths.systemCommandPath])) {
    assertInstallationPath(path, "command", "zelavis");
    addStep(steps, `command:${path}`, `Remove only a Zelavis-owned command link at ${path}`, { kind: "remove-link", path, prefix: paths.prefix });
  }
  const removed = new Set<string>();
  const remove = (path: string, recursive = false) => {
    if (removed.has(path)) return;
    removed.add(path);
    addStep(steps, `remove:${path}`, `Remove ${path}`, { kind: "remove", path, recursive });
  };
  for (const unit of WORKER_UNITS) {
    for (const directory of paths.systemdDirectories) {
      remove(`${directory}/${unit}`);
      remove(`${directory}/${unit}.d`, true);
    }
    remove(`${paths.systemdDirectories[0]}/multi-user.target.wants/${unit}`);
  }
  if (input.hostCommands) {
    addStep(steps, "account", "Remove only the recorded installer-created worker account, when its properties still prove it", {
      kind: "remove-account", account: WORKER_ACCOUNT, dataDirectory: paths.dataDirectory, ownsUser: receipt.ownsUser, ownsGroup: receipt.ownsGroup,
    });
    systemctl("reload", ["daemon-reload"]);
    systemctl("reset", ["reset-failed", ...WORKER_UNITS]);
  }
  addStep(steps, `remove:${paths.dataDirectory}`, `Remove ${paths.dataDirectory}, including the Agent's key, certificate, trust keys and every Project run here`, { kind: "remove", path: paths.dataDirectory, recursive: true });
  addStep(steps, `remove:${paths.prefix}`, `Remove ${paths.prefix}, including the installer lock, receipt and all releases`, { kind: "remove", path: paths.prefix, recursive: true });
  return {
    operation: "uninstall",
    installation: { kind: "packaged", path: `${paths.prefix}/current/platform/dist/cli.js`, root: paths.prefix },
    instance: "worker",
    dataDirectory: paths.dataDirectory,
    steps, warnings: [],
    retained: [...ZELAVIS_INSTALLATION_RETAINED_STATE, "The node's record on its Platform: remove it there with `zelavis nodes remove`"],
  };
}
