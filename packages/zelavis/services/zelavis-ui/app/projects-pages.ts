import { Effect } from "effect";
import { ApiError, array, label, object, request } from "./api.ts";
import { button, empty, link, message, node } from "./dom.ts";
import { badge, card, columns, facts, flashNotice, page, resourceNotice, setFlash } from "./page-kit.ts";
import type { ScreenContext } from "./screens.ts";
import { dropdown } from "./dropdown.ts";

/** The Projects overview: search, create, and every Project's lifecycle controls. State lives in the URL. */

interface Recipe {
  name: string;
  title: string;
  hostPackages: readonly string[];
  methods: readonly { id: string; driver: string; requires: readonly string[] }[];
  software: readonly string[];
  hasInstall: boolean;
}

const recipesOf = (config: ScreenContext["config"]): Recipe[] => array(config.serviceRegistry).map(object).filter(service => service.kind === "app").map(service => {
  const project = object(service.project);
  const install = object(project.install);
  const marketplace = object(service.marketplace);
  return {
    name: label(service.name, ""),
    title: label(marketplace.title ?? object(service.menu).title ?? service.name),
    hostPackages: array(project.hostPackages).filter((name): name is string => typeof name === "string"),
    methods: array(install.methods).map(object).map(method => ({ id: label(method.id, ""), driver: label(method.driver, ""), requires: array(method.requires).map(String) })),
    software: array(install.software).map(object).map(entry => label(entry.version, "")),
    hasInstall: project.install !== undefined && project.install !== null
  };
});

/** The browser-facing site address; an Agent's private loopback target is never offered to another machine. */
export function siteUrl(project: Record<string, unknown>, browser: URL): string | undefined {
  const runtime = object(project.runtime);
  if (runtime.status !== "running") return undefined;
  const preview = object(project.preview);
  const port = Number(preview.port);
  if (preview.status === "ready" && Number.isInteger(port) && port >= 1024 && port <= 65535) {
    const site = new URL(browser.origin);
    site.protocol = "http:"; site.port = String(port); site.pathname = "/";
    return site.href;
  }
  if (project.preview === undefined || project.preview === null) {
    if (typeof runtime.url !== "string") return undefined;
    try {
      const target = new URL(runtime.url);
      const local = new Set(["localhost", "127.0.0.1", "[::1]"]);
      if (local.has(browser.hostname) && local.has(target.hostname)) return target.href;
    } catch { return undefined; }
  }
  return undefined;
}

const dateText = (value: unknown) => { const date = new Date(label(value, "")); return Number.isNaN(date.getTime()) ? label(value) : date.toLocaleString(); };
const select = (name: string, aria: string, options: readonly (readonly [value: string, text: string, disabled?: boolean])[], selected: string) =>
  dropdown({ name, label: aria, value: selected }, options.map(([value, text, disabled]) => ({ value, label: text, ...(disabled ? { disabled } : {}) })));

export const projectsOverviewScreen = Effect.fn("ui.projectsOverview")(function*(context: ScreenContext) {
  const api = context.config.api.basePath;
  const list = array(object(yield* request(`${api}/runtime/projects`)).projects).map(object);
  context.projectsNavigation(list.map(entry => ({ ...entry, status: label(object(entry.runtime).status, "stopped") })) as never);
  const params = context.url.searchParams;
  const query = (params.get("q") ?? "").trim().toLowerCase();
  const showCreate = params.get("new") === "1";
  const recipes = recipesOf(context.config);
  const canCreate = array(object(object(context.config.access).principal).permissions).includes("*") || context.config.access === undefined;
  const flash = flashNotice("Project updated");
  const say = setFlash;
  const act = (effect: Effect.Effect<unknown, ApiError>, done: (result: Record<string, unknown>) => string | undefined) =>
    context.run(effect, result => { const text = done(object(result)); if (text) say(text); context.refresh(); });

  const sections: (Node | undefined)[] = [flash];

  if (showCreate && canCreate) {
    const selected = recipes.find(recipe => recipe.name === params.get("recipe")) ?? recipes.find(recipe => recipe.name === "@zelavis/app") ?? recipes[0];
    const versions = selected?.name === "@zelavis/app"
      ? object(yield* request(`${api}/runtime/project-versions`).pipe(Effect.catch(error => Effect.succeed({ selectable: false, reason: error.message, versions: [] }))))
      : undefined;
    const name = node("input", { name: "name", placeholder: "My application", required: "", value: params.get("name") ?? "", "aria-label": "Name", autocomplete: "off" });
    const keep = (values: Record<string, string | undefined>) => context.setSearch({ name: name.value || undefined, ...values });
    const recipeSelect = select("recipeName", "Project recipe", recipes.map(recipe => [recipe.name, recipe.title] as const), selected?.name ?? "");
    recipeSelect.addEventListener("change", () => keep({ recipe: recipeSelect.value || undefined, engineVersion: undefined, method: undefined, software: undefined }));
    const fields: HTMLElement[] = [node("label", {}, node("span", {}, "Name"), name), node("label", {}, node("span", {}, "Project recipe"), recipeSelect)];
    if (versions) {
      const engine = select("engineVersion", "Zelavis version", [["", `Latest available${typeof versions.latest === "string" ? ` (${versions.latest})` : ""}`], ...array(versions.versions).map(object).map(entry => [label(entry.version, ""), `${label(entry.version)}${entry.status !== "available" ? " (unavailable)" : ""}`, entry.status !== "available"] as const)], params.get("engineVersion") ?? "");
      if (versions.selectable !== true) engine.setAttribute("disabled", "");
      engine.addEventListener("change", () => keep({ engineVersion: engine.value || undefined }));
      fields.push(node("label", {}, node("span", {}, "Zelavis version"), engine), ...(typeof versions.reason === "string" ? [node("p", { class: "muted" }, versions.reason)] : []));
    }
    if (selected?.hasInstall) {
      const method = select("method", "Install method", [["", "Automatic (the first this server can run)"], ...selected.methods.map(entry => [entry.id, `${entry.id} (${entry.driver === "oci" || entry.requires.includes("docker") ? "container" : "native"}${entry.requires.length ? `, needs ${entry.requires.join(", ")}` : ""})`] as const)], params.get("method") ?? "");
      method.addEventListener("change", () => keep({ method: method.value || undefined }));
      const software = select("software", "Software version", [["", "Newest available"], ...selected.software.map(version => [version, version] as const)], params.get("software") ?? "");
      software.addEventListener("change", () => keep({ software: software.value || undefined }));
      fields.push(node("label", {}, node("span", {}, "Install method"), method), node("label", {}, node("span", {}, "Software version"), software));
    }
    const packages = node("input", { type: "checkbox", name: "installHostPackages" });
    if (selected?.hostPackages.length) fields.push(node("label", {}, node("span", {}, `Install required host packages (${selected.hostPackages.join(", ")}) if missing. This changes the server and requires host package installation permission. Existing host services keep their configuration.`), packages));
    const submit = node("button", { type: "submit", class: "primary" }, "Create");
    if (recipes.length === 0) submit.setAttribute("disabled", "");
    const form = node("form", { class: "form" }, ...fields, node("div", { class: "actions" }, submit, button("Cancel", () => context.setSearch({ new: undefined, name: undefined, recipe: undefined, engineVersion: undefined, method: undefined, software: undefined }))));
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (submit.hasAttribute("disabled")) return;
      submit.setAttribute("disabled", "");
      const body = {
        name: name.value.trim(), recipeName: selected?.name ?? "", start: true,
        ...(selected?.name === "@zelavis/app" && params.get("engineVersion") ? { engineVersion: params.get("engineVersion") } : {}),
        ...(selected?.hasInstall && params.get("method") ? { method: params.get("method") } : {}),
        ...(selected?.hasInstall && params.get("software") ? { softwareVersion: params.get("software") } : {}),
        ...(packages.checked ? { installHostPackages: true } : {})
      };
      context.run(request(`${api}/runtime/projects`, "POST", body).pipe(Effect.ensuring(Effect.sync(() => submit.removeAttribute("disabled")))), result => {
        say(`${label(object(object(result).project).name)} is running in its own project runtime.`);
        context.setSearch({ new: undefined, name: undefined, recipe: undefined, engineVersion: undefined, method: undefined, software: undefined });
      });
    });
    sections.push(card("Create project", form));
  }

  const search = node("input", { name: "q", type: "search", placeholder: "Search projects", value: params.get("q") ?? "", "aria-label": "Search projects" });
  const bar = node("form", { class: "filters", role: "search" }, node("label", {}, search), ...(canCreate ? [button("New project", () => context.setSearch({ new: "1" }), { class: "primary" })] : []));
  bar.addEventListener("submit", event => { event.preventDefault(); context.setSearch({ q: search.value.trim() || undefined }); });
  sections.push(bar);

  const visible = list.filter(project => !query || [label(project.name, ""), label(project.id, ""), label(object(project.runtime).url, "")].some(value => value.toLowerCase().includes(query)));
  const versionProject = params.get("versionProject") ?? "";
  const versionTarget = versionProject ? visible.find(project => label(project.id, "") === versionProject) : undefined;
  const versionData = versionTarget
    ? object(yield* request(`${api}/runtime/projects/${encodeURIComponent(versionProject)}/versions`).pipe(Effect.catch(error => Effect.succeed({ selectable: false, reason: error.message, versions: [] }))))
    : undefined;
  const cards = visible.map(project => projectCard(context, project, recipes, act, label(project.id, "") === versionProject ? versionData : undefined));
  if (cards.length) sections.push(node("div", { class: "k-grid cols-3" }, ...cards));
  else if (list.length === 0) sections.push(empty("No projects yet", "Create a Zelavis App project to start its independent local runtime."));
  else sections.push(resourceNotice("No matching projects", "Try a different project search."));
  return page(...sections);
});

function projectCard(context: ScreenContext, project: Record<string, unknown>, recipes: readonly Recipe[], act: (effect: Effect.Effect<unknown, ApiError>, done: (result: Record<string, unknown>) => string | undefined) => void, versions?: Record<string, unknown>) {
  const api = context.config.api.basePath;
  const id = label(project.id, "");
  const name = label(project.name);
  const path = `${api}/runtime/projects/${encodeURIComponent(id)}`;
  const runtime = object(project.runtime);
  const recipe = object(project.recipe);
  const status = label(runtime.status, "stopped");
  const deletion = project.deletion ? object(project.deletion) : undefined;
  const update = project.runtimeUpdate ? object(project.runtimeUpdate) : undefined;
  const recipeStatus = project.recipeStatus ? object(project.recipeStatus) : undefined;
  const capabilities = object(project.capabilities);
  const running = status === "running" && !deletion;
  const site = siteUrl(project, context.url);
  const preview = object(project.preview);
  const blocked = !!deletion || !!update;

  const body: Node[] = [
    node("div", { class: "toolbar" }, node("div", {}, node("h2", {}, name), node("code", {}, id)), badge(status)),
    facts([
      ["Recipe", `${label(recipe.title, label(recipe.name))}${recipe.version ? ` ${label(recipe.version)}` : ""}`],
      ["Runtime", `${label(project.runtimeKind, "native")} · ${label(runtime.driver)}`],
      ["Site", site ?? (preview.status === "unavailable" ? "Preview unavailable" : "Not published")],
      ["Updated", dateText(project.updatedAt)]])
  ];
  if (site) body.push(node("a", { href: site, target: "_blank", rel: "noreferrer" }, "Open site"));
  if (deletion) body.push(node("div", { class: "notice error", "aria-label": "Project deletion" },
    node("strong", {}, deletion.status === "failed" ? "Deletion failed" : "Deletion in progress"),
    node("p", {}, "This Project is pending deletion. Starting and recipe upgrades are unavailable. Retry deletion to finish removing its remaining resources."),
    ...(deletion.currentParticipant ? [node("p", {}, `Cleanup step: ${label(deletion.currentParticipant)}`)] : []),
    ...(typeof deletion.error === "string" ? [node("p", {}, deletion.error)] : [])));
  if (typeof runtime.error === "string") body.push(message(runtime.error, true));
  if (typeof preview.error === "string") body.push(message(preview.error, true));

  if (update || recipeStatus && recipeStatus.state !== "current") body.push(upgradeNotice(project, recipes, act, path));

  if (versions) body.push(versionPanel(context, project, path, act, versions));

  const actions: HTMLElement[] = [];
  if (recipe.name === "@zelavis/app" && capabilities.independentRuntimeVersion) {
    actions.push(button("Manage version", () => context.setSearch({ versionProject: id, engineVersion: undefined, new: undefined }), blocked ? { disabled: "" } : {}));
  }
  actions.push(running ? link("Open", `/projects/${encodeURIComponent(id)}`, { class: "primary" }) : button("Open", () => {}, { disabled: "", title: "Start the Project to open it" }));
  actions.push(button(running ? "Stop" : "Start", () => act(request(`${path}/${running ? "stop" : "start"}`, "POST", {}), () => `${name} ${running ? "stopped" : "started"}.`), blocked && !running || deletion || update && !running ? { disabled: "" } : {}));
  actions.push(button("Restart", () => act(request(`${path}/restart`, "POST", {}), () => `${name} restarted.`), blocked || status === "provisioning" ? { disabled: "" } : {}));
  actions.push(button(deletion ? "Retry deletion" : "Delete", () => {
    if (window.confirm(deletion ? `Retry deletion of ${name}? This permanently removes the remaining project runtime, database, files, and metadata.` : `Delete ${name}? This permanently removes the project runtime, database, files, and metadata.`)) act(request(path, "DELETE"), () => `${name} was deleted.`);
  }, { class: "danger" }));
  actions.push(link("Ask Assistant", `/assistant?project=${encodeURIComponent(id)}`, { "aria-label": `Ask Assistant about ${name}` }));
  body.push(node("div", { class: "actions" }, ...actions));
  return node("article", { class: "k-card" }, ...body);
}

function upgradeNotice(project: Record<string, unknown>, recipes: readonly Recipe[], act: (effect: Effect.Effect<unknown, ApiError>, done: (result: Record<string, unknown>) => string | undefined) => void, path: string) {
  const name = label(project.name);
  const runtime = object(project.runtime);
  const capabilities = object(project.capabilities);
  const status = object(project.recipeStatus);
  const idle = runtime.status === "stopped" || runtime.status === "failed";
  const live = runtime.status === "running" && capabilities.zeroDowntimeUpdates === true;
  const integration = capabilities.recipeUpdateMode === "integration";
  const restarts = runtime.status === "running" && !live && !integration;
  const canUpgrade = idle || live || restarts;
  const upgrade = (recipeName?: string) => act(request(`${path}/upgrade`, "POST", { restart: true, ...(recipeName ? { recipeName } : {}) }), result => {
    const upgraded = object(result.project ?? result);
    const next = object(upgraded.recipe);
    return `${name} now uses ${label(next.name)}${next.version ? ` ${label(next.version)}` : ""}. Its data is unchanged. ${object(upgraded.runtime).status === "running" ? "It is running at the same address." : "Start it when you are ready."}`;
  });
  if (project.deletion) return node("div");
  if (project.runtimeUpdate) {
    const update = object(project.runtimeUpdate);
    return node("div", { class: "notice", "aria-label": "Project update" }, node("strong", {}, update.error ? "Update recovery required" : "Update in progress"),
      ...(typeof update.error === "string" ? [node("p", { class: "danger" }, update.error), button("Retry update", () => upgrade())] : []));
  }
  const copy = status.state === "upgradeAvailable"
    ? integration
      ? `A newer recipe is available: ${label(status.version)}. Updates this app's Zelavis integration while its service keeps running. The app manages its own software updates.`
      : `A newer recipe is available: ${label(status.version)}. Upgrading keeps this Project's data${restarts ? " and restarts it, so it is unavailable for a short while" : ""}. The application's own software is not changed.`
    : `${label(status.reason, "")} Choose a recipe to move this Project to; its data is kept${restarts ? ", and it is restarted for the move" : ""}.`;
  const target = dropdown({ label: "Recipe to move to" }, recipes.map(recipe => ({ value: recipe.name, label: recipe.title })));
  const go = button(integration ? "Update recipe" : "Upgrade recipe", () => upgrade(status.state === "unavailable" ? target.value : undefined));
  if (!canUpgrade || status.state === "unavailable" && recipes.length === 0) go.setAttribute("disabled", "");
  return node("div", { class: "notice", "aria-label": "Recipe upgrade" }, node("p", {}, copy), ...(status.state === "unavailable" ? [target] : []), go,
    ...(canUpgrade ? [] : [node("span", { class: "muted" }, "Wait for the Project to finish starting or stopping.")]));
}

function versionPanel(context: ScreenContext, project: Record<string, unknown>, path: string, act: (effect: Effect.Effect<unknown, ApiError>, done: (result: Record<string, unknown>) => string | undefined) => void, versions: Record<string, unknown>) {
  const current = typeof versions.current === "string" ? versions.current : "";
  const choice = context.url.searchParams.get("engineVersion") ?? "";
  const blocked = !!project.deletion || !!project.runtimeUpdate || versions.selectable !== true;
  const pick = select("version", "Zelavis version", [...(current ? [] : [["", "Choose a version"] as const]), ...array(versions.versions).map(object).map(entry => [label(entry.version, ""), `${label(entry.version)}${entry.status !== "available" ? " (unavailable)" : ""}`, entry.status !== "available"] as const)], choice || current);
  if (blocked) pick.setAttribute("disabled", "");
  pick.addEventListener("change", () => context.setSearch({ engineVersion: pick.value || undefined }));
  const apply = button("Switch version", () => act(request(`${path}/version`, "POST", { version: pick.value }), result => `${label(project.name)} now uses Zelavis ${label(object(result.project).engineVersion, pick.value)}.`), { class: "primary", ...(blocked || !choice || choice === current ? { disabled: "" } : {}) });
  return node("div", { class: "notice", "aria-label": "App version" },
    node("p", {}, `Current Zelavis version: ${current || label(project.engineVersion, "Unavailable")}`),
    node("p", { class: "muted" }, "Select an installed version and its matching App recipe. Project data is preserved."),
    ...(typeof versions.reason === "string" ? [node("p", {}, versions.reason)] : []), pick,
    node("div", { class: "actions" }, apply, button("Cancel", () => context.setSearch({ versionProject: undefined, engineVersion: undefined }))));
}
