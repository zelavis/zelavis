import { readFile, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import { integration, integrationValue, present } from "../core/runtime/effect-boundary.js";
import type { ZelavisProjectRecord } from "../project.js";
import { createZelavisClient, type ZelavisTenantBackup, type ZelavisTenantRestoreMode } from "../sdk/fetch.js";

const usage =
  "zelavis projects <list|recipes|versions|setup|setup-audit|get|create|rename|start|stop|restart|upgrade|switch-version|logs|remove|export-tenant|restore-tenant> [id|name] [new-name] [--id ID] [--recipe NAME] [--engine-version EXACT] [--method ID] [--software-version V] [--no-start] [--restart] [--reveal] [--install-host-packages] [--tenant ID] [--output FILE] [--file BACKUP.json] [--into empty|purge|merge] [--url URL] [--token TOKEN] [--json]";

/**
 * A backup file read back, checked only for being one.
 *
 * The restore checks the format, the Tenant and every identifier itself; this
 * is so that a wrong file fails here with its name rather than as a request.
 */
const readBackup = (text: string, file: string): ZelavisTenantBackup => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const candidate = parsed as { readonly tenantId?: unknown; readonly events?: unknown } | null;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)
    || typeof candidate.tenantId !== "string" || !Array.isArray(candidate.events)) {
    throw new Error(`${file} is not a Tenant backup.`);
  }
  return candidate as ZelavisTenantBackup;
};

/**
 * `zelavis projects` — the Project routes through the JS SDK client.
 *
 * Commands call `client.projects.*` rather than their own requests, so the CLI
 * cannot drift from the SDK's contract. `--json` prints the SDK result as-is;
 * failures are reported by `runCli` with the HTTP status and body.
 */
const projectsCommand = Effect.fn("ProjectsCLI.command")(function* (args: readonly string[]) {
  const positional: string[] = [];
  let url = "http://localhost:3000/zelavis";
  let token: string | undefined;
  let id: string | undefined;
  let recipe: string | undefined;
  let engineVersion: string | undefined;
  let method: string | undefined;
  let softwareVersion: string | undefined;
  let start = true;
  let installHostPackages = false;
  let restart = false;
  let reveal = false;
  let tenant: string | undefined;
  let output: string | undefined;
  let file: string | undefined;
  let into: string | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--install-host-packages") { installHostPackages = true; continue; }
    if (arg === "--no-start") { start = false; continue; }
    if (arg === "--restart") { restart = true; continue; }
    if (arg === "--reveal") { reveal = true; continue; }
    if (arg === "--help" || arg === "-h") {
      console.log(usage);
      return;
    }
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    const separator = arg.indexOf("=");
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    if (!["--url", "--token", "--id", "--recipe", "--engine-version", "--method", "--software-version", "--tenant", "--output", "--file", "--into"].includes(flag)) {
      throw new Error(`Unknown projects option "${arg}".`);
    }
    const value = separator === -1 ? args[++index] : arg.slice(separator + 1);
    if (!value) throw new Error(`${flag} requires a value.`);
    if (flag === "--url") url = value;
    if (flag === "--token") token = value;
    if (flag === "--id") id = value;
    if (flag === "--recipe") recipe = value;
    if (flag === "--engine-version") engineVersion = value;
    if (flag === "--method") method = value;
    if (flag === "--software-version") softwareVersion = value;
    if (flag === "--tenant") tenant = value;
    if (flag === "--output") output = value;
    if (flag === "--file") file = value;
    if (flag === "--into") into = value;
  }

  const [action, target, ...rest] = positional;
  if (!action) {
    console.log(usage);
    return;
  }
  if (rest.length > (action === "rename" ? 1 : 0)) throw new Error(`Unexpected argument "${rest[action === "rename" ? 1 : 0]}". ${usage}`);
  if (reveal && action !== "setup") throw new Error("--reveal is only supported by projects setup.");
  if (restart && action !== "upgrade") throw new Error("--restart is only supported by projects upgrade.");
  if (installHostPackages && action !== "create") throw new Error("--install-host-packages is only supported by projects create.");
  if ((method || softwareVersion) && action !== "create") throw new Error("--method and --software-version are only supported by projects create.");
  if (engineVersion && !["create", "upgrade", "switch-version"].includes(action)) throw new Error("--engine-version is only supported by create, upgrade and switch-version.");
  if (tenant && !["export-tenant", "restore-tenant"].includes(action)) throw new Error("--tenant is only supported by projects export-tenant and restore-tenant.");
  if (output && action !== "export-tenant") throw new Error("--output is only supported by projects export-tenant.");
  if ((file || into) && action !== "restore-tenant") throw new Error("--file and --into are only supported by projects restore-tenant.");
  const base = new URL(url);
  const client = createZelavisClient({
    baseUrl: base.origin,
    rootPath: base.pathname,
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  const requireTarget = (label: string) => {
    if (!target) throw new Error(`projects ${action} requires a Project ${label}.`);
    return target;
  };
  const print = (value: unknown, text: () => string) =>
    console.log(json ? JSON.stringify(value, null, 2) : text());
  const line = (project: ZelavisProjectRecord) =>
    `${project.id}\t${project.engineVersion ?? "current engine"}\t${project.runtime.status}\t${project.recipe.name}@${project.recipe.version}\t${project.runtimeKind}` +
    (project.recipeStatus?.state === "upgradeAvailable"
      ? `\tupgrade available: ${project.recipeStatus.version}`
      : project.recipeStatus?.state === "unavailable"
        ? "\trecipe not shipped: upgrade with --recipe"
        : "") +
    (project.isolation && project.isolation.shortfalls.length > 0
      ? `\tisolation: ${project.isolation.shortfalls.map((item) => `${item.requirement}(${item.enforcement})`).join(",")}`
      : "");

  switch (action) {
    case "list": {
      const result = yield* integration(() => client.projects.list());
      print(result, () => result.projects.map(line).join("\n") || "No Projects.");
      return;
    }
    case "recipes": {
      const recipes = yield* integration(() => client.projects.recipes());
      print({ projectRecipes: recipes }, () =>
        recipes.map((entry) => `${entry.name}\t${entry.runtimeKinds.join(",")}\t${entry.title}` +
          (entry.install ? `\tmethods ${entry.install.methods.map((method) => method.id).join(",")}\tsoftware ${entry.install.software.map((software) => software.version).join(",")}` : "")).join("\n"));
      return;
    }
    case "versions": {
      const result = yield* integration(() => client.projects.versions(target));
      print(result, () => result.selectable ? result.versions.map(entry => `${entry.version}\t${entry.status}${entry.version === result.current ? "\tselected" : ""}${entry.error ? `\t${entry.error}` : ""}`).join("\n") : result.reason ?? "Independent engine versions are unavailable.");
      return;
    }
    case "setup": {
      const values = yield* integration(() => reveal ? client.projects.revealSetup(requireTarget("id")) : client.projects.setup(requireTarget("id")));
      print({ values }, () => values.map(value => `${value.label}\t${value.secret && value.value === undefined ? "(secret: use --reveal)" : value.value}`).join("\n") || "This Project has no setup values.");
      return;
    }
    case "setup-audit": {
      const reveals = yield* integration(() => client.projects.setupReveals(requireTarget("id")));
      print({ reveals }, () => reveals.map(entry => `${new Date(entry.at).toISOString()}\t${entry.principalType}:${entry.principalId}\t${entry.revealed.join(",")}`).join("\n") || "No reveals.");
      return;
    }
    case "switch-version": {
      if (!engineVersion) throw new Error("projects switch-version requires --engine-version <exact version>.");
      const project = yield* integration(() => client.projects.switchVersion(requireTarget("id"), engineVersion!));
      print({ project }, () => `Selected ${line(project)}`);
      return;
    }
    case "get":
    case "start":
    case "stop":
    case "restart": {
      const projectId = requireTarget("id");
      const project = yield* integration(() => client.projects[action](projectId));
      print({ project }, () => line(project));
      return;
    }
    case "create": {
      const project = yield* integration(() => client.projects.create({
        name: requireTarget("name"),
        ...(id ? { id } : {}),
        ...(recipe ? { recipeName: recipe } : {}),
        ...(engineVersion ? { engineVersion } : {}),
        ...(method ? { method } : {}),
        ...(softwareVersion ? { softwareVersion } : {}),
        start,
        ...(installHostPackages ? { installHostPackages: true } : {}),
      }));
      print({ project }, () => `Created ${line(project)}`);
      return;
    }
    case "upgrade": {
      const project = yield* integration(() => client.projects.upgrade(requireTarget("id"), {
        ...(restart ? { restart: true } : {}),
        ...(recipe ? { recipeName: recipe } : {}),
        ...(engineVersion ? { engineVersion } : {}),
      }));
      print({ project }, () => `Upgraded ${line(project)}`);
      return;
    }
    case "rename": {
      const name = rest[0];
      if (!name) throw new Error("projects rename requires a new Project name.");
      const project = yield* integration(() => client.projects.update(requireTarget("id"), {
        name,
      }));
      print({ project }, () => `Renamed ${line(project)}`);
      return;
    }
    case "logs": {
      const logs = yield* integration(() => client.projects.logs(requireTarget("id")));
      print({ logs }, () => logs.map((entry) => `${entry.timestamp} ${entry.stream} ${entry.message}`).join("\n"));
      return;
    }
    case "remove": {
      const result = yield* integration(() => client.projects.remove(requireTarget("id")));
      print(result, () => `Removed ${target}.`);
      return;
    }
    case "export-tenant": {
      const backup = yield* integration(() => client.projects.exportTenant(requireTarget("id"), tenant ? { tenantId: tenant } : undefined));
      if (!output) {
        // The backup is the output, whatever the format flag says: redirect it
        // to a file, or hand it to restore-tenant.
        console.log(JSON.stringify(backup, null, 2));
        return;
      }
      // Created owner-only: a backup holds every record of the Tenant.
      const destination = output;
      yield* integration(() => writeFile(destination, `${JSON.stringify(backup)}\n`, { mode: 0o600 }));
      print(
        { tenantId: backup.tenantId, events: backup.events.length, file: destination },
        () => `Exported ${backup.events.length} events of Tenant ${backup.tenantId} to ${destination}.`,
      );
      return;
    }
    case "restore-tenant": {
      if (!file) throw new Error("projects restore-tenant requires --file <backup.json>.");
      const backup = readBackup(yield* integrationValue(readFile(file, "utf8")), file);
      // The mode is passed as given: the restore refuses one it does not have,
      // with the same answer the SDK and HTTP get.
      const result = yield* integration(() => client.projects.restoreTenant(requireTarget("id"), backup, {
        ...(into ? { into: into as ZelavisTenantRestoreMode } : {}),
        ...(tenant ? { tenantId: tenant } : {}),
      }));
      print(result, () =>
        `Restored ${result.events} events into Tenant ${result.tenantId}` +
        (result.removed > 0 ? `, removing ${result.removed} records first` : "") +
        (result.superseded > 0 ? `, writing over ${result.superseded}` : "") + ".");
      return;
    }
    default:
      throw new Error(`Unknown projects command "${action}". ${usage}`);
  }
});

export function runProjectsCommand(args: readonly string[]): Promise<void> { return present(projectsCommand(args)); }
