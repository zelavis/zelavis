import { Effect } from "effect";
import { integration, present } from "../core/runtime/effect-boundary.js";
import type { ZelavisProjectRecord } from "../project.js";
import { createZelavisClient } from "../sdk/fetch.js";

const usage =
  "zelavis projects <list|recipes|versions|get|create|rename|start|stop|restart|upgrade|switch-version|logs|remove> [id|name] [new-name] [--id ID] [--recipe NAME] [--engine-version EXACT] [--no-start] [--install-host-packages] [--url URL] [--token TOKEN] [--json]";

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
  let start = true;
  let installHostPackages = false;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--install-host-packages") { installHostPackages = true; continue; }
    if (arg === "--no-start") { start = false; continue; }
    if (arg === "--help" || arg === "-h") {
      console.log(usage);
      return;
    }
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    const separator = arg.indexOf("=");
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    if (!["--url", "--token", "--id", "--recipe", "--engine-version"].includes(flag)) {
      throw new Error(`Unknown projects option "${arg}".`);
    }
    const value = separator === -1 ? args[++index] : arg.slice(separator + 1);
    if (!value) throw new Error(`${flag} requires a value.`);
    if (flag === "--url") url = value;
    if (flag === "--token") token = value;
    if (flag === "--id") id = value;
    if (flag === "--recipe") recipe = value;
    if (flag === "--engine-version") engineVersion = value;
  }

  const [action, target, ...rest] = positional;
  if (!action) {
    console.log(usage);
    return;
  }
  if (rest.length > (action === "rename" ? 1 : 0)) throw new Error(`Unexpected argument "${rest[action === "rename" ? 1 : 0]}". ${usage}`);
  if (installHostPackages && action !== "create") throw new Error("--install-host-packages is only supported by projects create.");
  if (engineVersion && !["create", "upgrade", "switch-version"].includes(action)) throw new Error("--engine-version is only supported by create, upgrade and switch-version.");
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
        recipes.map((entry) => `${entry.name}\t${entry.runtimeKinds.join(",")}\t${entry.title}`).join("\n"));
      return;
    }
    case "versions": {
      const result = yield* integration(() => client.projects.versions(target));
      print(result, () => result.selectable ? result.versions.map(entry => `${entry.version}\t${entry.status}${entry.version === result.current ? "\tselected" : ""}${entry.error ? `\t${entry.error}` : ""}`).join("\n") : result.reason ?? "Independent engine versions are unavailable.");
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
        start,
        ...(installHostPackages ? { installHostPackages: true } : {}),
      }));
      print({ project }, () => `Created ${line(project)}`);
      return;
    }
    case "upgrade": {
      const project = yield* integration(() => client.projects.upgrade(requireTarget("id"), {
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
    default:
      throw new Error(`Unknown projects command "${action}". ${usage}`);
  }
});

export function runProjectsCommand(args: readonly string[]): Promise<void> { return present(projectsCommand(args)); }
