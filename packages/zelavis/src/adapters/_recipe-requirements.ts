import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { Data, Effect } from "effect";
import { integration } from "../core/runtime/effect-boundary.js";

/**
 * The host requirements a recipe can name, and how this host finds them.
 *
 * A recipe's install method lists requirements by name (`nginx`, `php-fpm`, `mariadb`). Each name
 * stands for the executables the recipe's commands use. Finding them is the host's business, not
 * the recipe's: it differs between Debian (on `PATH`, sometimes under `/usr/sbin`) and macOS
 * (Homebrew's prefix), and a recipe that hard-coded either would run on one of them. The result is
 * a table from command name to an absolute path, which is all a recipe phase or a process plan
 * may execute.
 *
 * Every candidate is probed by running it with a version flag, because a name on `PATH` is not
 * proof that it works. On macOS with Homebrew a missing requirement is installed on demand (that
 * is the operator provisioning their own machine, so the Platform's environment is passed to
 * `brew`); on Linux installation needs the audited host-operation broker, so a missing
 * requirement is reported with how to approve it.
 */

export class RequirementUnavailable extends Data.TaggedError("RequirementUnavailable")<{ readonly message: string }> {}

interface RequirementCommand {
  /** Names tried in order. */
  readonly candidates: readonly string[];
  readonly versionArgs: readonly string[];
  /** A tool whose version flag is not supported but which runs. */
  readonly acceptProbeFailure?: boolean;
  /** Where Homebrew keeps it, relative to the formula's prefix. */
  readonly brewPath: string;
}

interface Requirement {
  readonly display: string;
  readonly brewFormula: string;
  readonly commands: Readonly<Record<string, RequirementCommand>>;
}

export const REQUIREMENTS: Readonly<Record<string, Requirement>> = Object.freeze({
  // The JavaScript runtime Zelavis itself runs on: always present, never installed.
  node: {
    display: "Node.js", brewFormula: "node",
    commands: { node: { candidates: [process.execPath], versionArgs: ["--version"], brewPath: "bin/node" } },
  },
  nginx: {
    display: "Nginx", brewFormula: "nginx",
    commands: { nginx: { candidates: ["nginx"], versionArgs: ["-v"], brewPath: "bin/nginx" } },
  },
  "php-fpm": {
    display: "PHP and PHP-FPM", brewFormula: "php",
    commands: {
      php: { candidates: ["php"], versionArgs: ["--version"], brewPath: "bin/php" },
      "php-fpm": { candidates: ["php-fpm", "php-fpm8.5", "php-fpm8.4", "php-fpm8.3", "php-fpm8.2"], versionArgs: ["-v"], brewPath: "sbin/php-fpm" },
    },
  },
  mariadb: {
    display: "MariaDB", brewFormula: "mariadb",
    commands: {
      mariadbd: { candidates: ["mariadbd"], versionArgs: ["--version"], brewPath: "bin/mariadbd" },
      "mariadb-install-db": { candidates: ["mariadb-install-db"], versionArgs: ["--help"], acceptProbeFailure: true, brewPath: "bin/mariadb-install-db" },
      mariadb: { candidates: ["mariadb"], versionArgs: ["--version"], brewPath: "bin/mariadb" },
    },
  },
});

/** Directories daemons live in on Debian and friends, which are often missing from a service's PATH. */
const EXTRA_SEARCH = ["/usr/sbin", "/sbin", "/usr/local/sbin", "/opt/homebrew/sbin"] as const;

const cleanEnvironment = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/", LANG: "C.UTF-8" });

const runOnce = (executable: string, args: readonly string[], inheritEnvironment = false) =>
  Effect.callback<{ code: number; stdout: string }, never>((resume) => {
    const child = spawn(executable, [...args], {
      env: inheritEnvironment ? { ...process.env } : cleanEnvironment(), stdio: ["ignore", "pipe", "ignore"], shell: false,
    });
    let stdout = "";
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < 64 * 1024) stdout += chunk.toString("utf8"); });
    child.once("error", () => { if (!settled) { settled = true; resume(Effect.succeed({ code: 127, stdout: "" })); } });
    child.once("close", (code) => { if (!settled) { settled = true; resume(Effect.succeed({ code: code ?? 1, stdout })); } });
    return Effect.sync(() => { if (!settled) { settled = true; child.kill("SIGKILL"); } });
  });

const isExecutable = (path: string) =>
  integration(() => stat(path)).pipe(
    Effect.map((stats) => stats.isFile() && (stats.mode & 0o111) !== 0),
    Effect.orElseSucceed(() => false),
  );

/** The absolute path of a bare name, searched the way a shell would plus the usual sbin directories. */
const which = (name: string) => Effect.gen(function* () {
  if (name.startsWith("/")) return (yield* isExecutable(name)) ? name : undefined;
  for (const directory of [...(process.env.PATH ?? "").split(delimiter), ...EXTRA_SEARCH]) {
    if (directory === "") continue;
    const path = join(directory, name);
    if (yield* isExecutable(path)) return path;
  }
  return undefined;
});

const brewAvailable = Effect.gen(function* () {
  if (process.platform !== "darwin") return false;
  return (yield* runOnce("brew", ["--version"], true)).code === 0;
});

const brewExecutable = (requirement: Requirement, command: RequirementCommand) => Effect.gen(function* () {
  if (!(yield* brewAvailable)) return undefined;
  // Homebrew resolves its own prefix from its environment, so asking it needs that environment.
  const prefix = yield* runOnce("brew", ["--prefix", requirement.brewFormula], true);
  const directory = prefix.stdout.trim();
  return prefix.code === 0 && directory ? join(directory, command.brewPath) : undefined;
});

const resolveCommand = (requirement: Requirement, command: RequirementCommand) => Effect.gen(function* () {
  const candidates = [...command.candidates];
  const fromBrew = yield* brewExecutable(requirement, command);
  if (fromBrew) candidates.push(fromBrew);
  for (const candidate of candidates) {
    const path = yield* which(candidate);
    if (path === undefined) continue;
    const probe = yield* runOnce(path, command.versionArgs);
    if (probe.code === 0 || command.acceptProbeFailure) return path;
  }
  return undefined;
});

/** Command name to absolute path for the named requirements, or the names still missing. */
const resolveAll = (requires: readonly string[]) => Effect.gen(function* () {
  const table: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of requires) {
    const requirement = REQUIREMENTS[name];
    if (!requirement) return yield* Effect.fail(new RequirementUnavailable({ message: `This host does not know the requirement "${name}".` }));
    for (const [commandName, command] of Object.entries(requirement.commands)) {
      const path = yield* resolveCommand(requirement, command);
      if (path === undefined) { if (!missing.includes(name)) missing.push(name); } else table[commandName] = path;
    }
  }
  return { table, missing };
});

export const resolveRequirementCommands = (requires: readonly string[]): Effect.Effect<Readonly<Record<string, string>>, RequirementUnavailable> =>
  Effect.gen(function* () {
    const first = yield* resolveAll(requires);
    if (first.missing.length === 0) return first.table;
    const display = first.missing.map((name) => REQUIREMENTS[name]!.display).join(", ");
    if (process.platform === "linux") {
      return yield* Effect.fail(new RequirementUnavailable({
        message: `This host is missing ${display}. Approve host package installation in the create-project form, or run: zelavis host-operations submit zelavis.packages-install --arg set=wordpress-stack`,
      }));
    }
    if (process.platform === "darwin" && (yield* brewAvailable)) {
      const formulas = [...new Set(first.missing.map((name) => REQUIREMENTS[name]!.brewFormula))];
      const installed = yield* runOnce("brew", ["install", ...formulas], true);
      if (installed.code !== 0) {
        return yield* Effect.fail(new RequirementUnavailable({
          message: `Zelavis could not install ${display} through Homebrew. Check the Homebrew installation and retry.`,
        }));
      }
      const second = yield* resolveAll(requires);
      if (second.missing.length === 0) return second.table;
    }
    return yield* Effect.fail(new RequirementUnavailable({
      message: `This host is missing ${display}, and has no supported package provider (APT on Debian or Ubuntu, Homebrew on macOS).`,
    }));
  });

/**
 * Requirement names this host satisfies now, or could satisfy on demand: Homebrew on macOS, or
 * (when the audited operation Agent exists) a package set on Linux.
 */
export const availableRequirements = (provisionableOnLinux: readonly string[]): Effect.Effect<readonly string[]> =>
  Effect.gen(function* () {
    const names = Object.keys(REQUIREMENTS);
    const present = yield* resolveAll(names).pipe(Effect.orElseSucceed(() => ({ table: {}, missing: names })));
    const have = names.filter((name) => !present.missing.includes(name));
    const onDemand = process.platform === "darwin" && (yield* brewAvailable) ? names
      : process.platform === "linux" ? provisionableOnLinux.filter((name) => name in REQUIREMENTS)
      : [];
    return [...new Set([...have, ...onDemand])];
  });
