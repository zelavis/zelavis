import { Effect } from "effect";
import { ApiError, array, label, object, request } from "./api.ts";
import { button, empty, link, message, node } from "./dom.ts";
import { badge, card, facts, flashNotice, page, resourceNotice, setFlash } from "./page-kit.ts";
import type { ScreenContext } from "./screens.ts";
import { dropdown } from "./dropdown.ts";
import { runtimeStatusText, standbyFact } from "./project-standby.ts";
import { canAccess } from "./navigation-menu.ts";

/** The Projects overview: search, create, and every Project's lifecycle controls. State lives in the URL. */

const trackedUpgrades = new Map<string, { readonly id: string; readonly mode: "recipe" | "version" }>();
const announcedUpgrades = new Set<string>();

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

/** What a data-layout migration changed, for the line shown after an upgrade; an upgrade that migrated nothing leaves the data as it was. */
function migrationSummary(value: unknown): string {
  const migration = object(value);
  if (migration.from === undefined || migration.to === undefined) return "Its data is unchanged.";
  const docs = Number(migration.documents ?? 0);
  const events = Number(migration.eventsCarried ?? 0);
  const restarted = Number(migration.documentsWithHistoryDropped ?? 0);
  if (docs === 0 && events === 0 && migration.retained === undefined) {
    return `Its data layout moved from format ${label(migration.from)} to format ${label(migration.to)}.`;
  }
  const backup = typeof migration.retained === "string"
    ? " A pre-upgrade backup was kept under Project Settings until you delete it."
    : "";
  return `Its data moved from layout ${label(migration.from)} to ${label(migration.to)} (${docs} documents recreated with their versions, ${events} change events carried${restarted > 0 ? `; ${restarted} documents of compacted Tenants kept their versions without their earlier change history` : ""}).${backup}`;
}

function upgradeDoneMessage(project: Record<string, unknown>, mode: "recipe" | "version", fallbackVersion?: string): string {
  const name = label(project.name);
  const upgrade = object(project.upgrade);
  const migration = upgrade.dataMigration ?? project.dataMigration;
  if (mode === "version") {
    return `${name} now uses Zelavis ${label(project.engineVersion, fallbackVersion ?? "")}. ${migrationSummary(migration)}`;
  }
  const next = object(project.recipe);
  return `${name} now uses ${label(next.name)}${next.version ? ` ${label(next.version)}` : ""}. ${migrationSummary(migration)} ${object(project.runtime).status === "running" ? "It is running at the same address." : "Start it when you are ready."}`;
}

export const projectsOverviewScreen = Effect.fn("ui.projectsOverview")(function*(context: ScreenContext) {
  const api = context.config.api.basePath;
  const list = array(object(yield* request(`${api}/runtime/projects`)).projects).map(object);
  context.projectsNavigation(list.map(entry => ({ ...entry, status: label(object(entry.runtime).status, "stopped") })) as never);
  const params = context.url.searchParams;
  const query = (params.get("q") ?? "").trim().toLowerCase();
  const showCreate = params.get("new") === "1";
  const recipes = recipesOf(context.config);
  const canCreate = canAccess(context.config.access, { permissions: ["projects.create"] });
  const say = setFlash;

  // Catch fast async upgrades that already finished before this refresh landed.
  for (const entry of list) {
    const id = label(entry.id, "");
    const up = entry.upgrade ? object(entry.upgrade) : undefined;
    if (up?.state === "running" && typeof up.id === "string" && !trackedUpgrades.has(id)) {
      trackedUpgrades.set(id, { id: up.id, mode: "recipe" });
    } else if (up?.state === "completed" && typeof up.id === "string" && trackedUpgrades.get(id)?.id === up.id && !announcedUpgrades.has(up.id)) {
      const tracked = trackedUpgrades.get(id)!;
      announcedUpgrades.add(up.id);
      trackedUpgrades.delete(id);
      say(upgradeDoneMessage(entry, tracked.mode));
    } else if (up?.state === "failed" && typeof up.id === "string" && trackedUpgrades.get(id)?.id === up.id) {
      trackedUpgrades.delete(id);
    }
  }

  const flash = flashNotice("Project updated");
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
      context.run(request(`${api}/runtime/projects`, "POST", body, undefined, 120).pipe(Effect.ensuring(Effect.sync(() => submit.removeAttribute("disabled")))), result => {
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
  const versionTarget = versionProject && canAccess(context.config.access, { permissions: ["project.runtime.manage"], scope: { type: "project", projectId: versionProject } })
    ? visible.find(project => label(project.id, "") === versionProject) : undefined;
  const versionData = versionTarget
    ? object(yield* request(`${api}/runtime/projects/${encodeURIComponent(versionProject)}/versions`).pipe(Effect.catch(error => Effect.succeed({ selectable: false, reason: error.message, versions: [] }))))
    : undefined;

  const phaseNodes = new Map<string, HTMLElement>();
  const activeIds = new Set<string>();
  for (const project of list) {
    const id = label(project.id, "");
    const up = project.upgrade ? object(project.upgrade) : undefined;
    const rtUpdate = project.runtimeUpdate ? object(project.runtimeUpdate) : undefined;
    if (up?.state === "running" || (rtUpdate !== undefined && typeof rtUpdate.error !== "string")) {
      activeIds.add(id);
    }
  }

  const cards = visible.map(project => projectCard(context, project, recipes, act, phaseNodes, label(project.id, "") === versionProject ? versionData : undefined));
  if (cards.length) sections.push(node("div", { class: "k-grid cols-3" }, ...cards));
  else if (list.length === 0) sections.push(canCreate
    ? empty("No projects yet", "Create a Zelavis App project to start its independent local runtime.")
    : empty("No projects assigned", "Your account can access Projects after an administrator assigns a Project grant."));
  else sections.push(resourceNotice("No matching projects", "Try a different project search."));

  if (activeIds.size > 0) {
    yield* Effect.forkScoped(Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep("1500 millis");
        const polled = yield* request(`${api}/runtime/projects`).pipe(
          Effect.map(result => array(object(result).projects).map(object)),
          Effect.catch(() => Effect.succeed(undefined)),
        );
        if (!polled) continue;
        let shouldRefresh = false;
        for (const id of activeIds) {
          const current = polled.find(entry => label(entry.id, "") === id);
          const up = current?.upgrade ? object(current.upgrade) : undefined;
          const rtUpdate = current?.runtimeUpdate ? object(current.runtimeUpdate) : undefined;
          const stillRunning = up?.state === "running" || (rtUpdate !== undefined && typeof rtUpdate.error !== "string");
          if (!stillRunning) {
            if (current && up?.state === "completed" && typeof up.id === "string" && !announcedUpgrades.has(up.id)) {
              const tracked = trackedUpgrades.get(id);
              announcedUpgrades.add(up.id);
              trackedUpgrades.delete(id);
              say(upgradeDoneMessage(current, tracked?.mode ?? "recipe"));
            } else if (up?.state === "failed") {
              trackedUpgrades.delete(id);
            }
            shouldRefresh = true;
          } else if (typeof up?.phase === "string") {
            const phaseNode = phaseNodes.get(id);
            if (phaseNode) phaseNode.textContent = `${up.phase}…`;
          }
        }
        if (shouldRefresh) {
          context.refresh();
          return;
        }
      }
    }));
  }

  return page(...sections);
});

function projectCard(context: ScreenContext, project: Record<string, unknown>, recipes: readonly Recipe[], act: (effect: Effect.Effect<unknown, ApiError>, done: (result: Record<string, unknown>) => string | undefined) => void, phaseNodes: Map<string, HTMLElement>, versions?: Record<string, unknown>) {
  const api = context.config.api.basePath;
  const id = label(project.id, "");
  const name = label(project.name);
  const path = `${api}/runtime/projects/${encodeURIComponent(id)}`;
  const runtime = object(project.runtime);
  const recipe = object(project.recipe);
  const status = label(runtime.status, "stopped");
  const deletion = project.deletion ? object(project.deletion) : undefined;
  const update = project.runtimeUpdate ? object(project.runtimeUpdate) : undefined;
  const upgrade = project.upgrade ? object(project.upgrade) : undefined;
  const upgrading = upgrade?.state === "running";
  const recipeStatus = project.recipeStatus ? object(project.recipeStatus) : undefined;
  const capabilities = object(project.capabilities);
  const running = status === "running" && !deletion;
  const site = siteUrl(project, context.url);
  const preview = object(project.preview);
  const blocked = !!deletion || !!update || upgrading;
  const allowed = (permission: string) => canAccess(context.config.access, { permissions: [permission], scope: { type: "project", projectId: id } });
  const managesRuntime = allowed("project.runtime.manage");

  const body: Node[] = [
    node("div", { class: "toolbar" }, node("div", {}, node("h2", {}, name), node("code", {}, id)), badge(upgrading ? "upgrading" : runtimeStatusText(status))),
    facts([
      ["Recipe", `${label(recipe.title, label(recipe.name))}${recipe.version ? ` ${label(recipe.version)}` : ""}`],
      ["Runtime", `${label(project.runtimeKind, "native")} · ${label(runtime.driver)}`],
      ["Site", site ?? (preview.status === "unavailable" ? "Preview unavailable" : "Not published")],
      ...(standbyFact(project) ? [standbyFact(project)!] : []),
      ["Updated", dateText(project.updatedAt)]])
  ];
  if (site && allowed("project.view")) body.push(node("a", { href: site, target: "_blank", rel: "noreferrer" }, "Open site"));
  if (deletion) body.push(node("div", { class: "notice error", "aria-label": "Project deletion" },
    node("strong", {}, deletion.status === "failed" ? "Deletion failed" : "Deletion in progress"),
    node("p", {}, "This Project is pending deletion. Starting and recipe upgrades are unavailable. Retry deletion to finish removing its remaining resources."),
    ...(deletion.currentParticipant ? [node("p", {}, `Cleanup step: ${label(deletion.currentParticipant)}`)] : []),
    ...(typeof deletion.error === "string" ? [node("p", {}, deletion.error)] : [])));
  if (typeof runtime.error === "string") body.push(message(runtime.error, true));
  if (typeof preview.error === "string") body.push(message(preview.error, true));

  if (managesRuntime && (upgrading || upgrade?.state === "failed" || update || recipeStatus && recipeStatus.state !== "current" || project.dataLayout)) {
    body.push(upgradeNotice(project, recipes, act, path, phaseNodes));
  }

  if (versions) body.push(versionPanel(context, project, path, act, versions));

  const actions: HTMLElement[] = [];
  if (managesRuntime && recipe.name === "@zelavis/app" && capabilities.independentRuntimeVersion) {
    actions.push(button("Manage version", () => context.setSearch({ versionProject: id, engineVersion: undefined, new: undefined }), blocked ? { disabled: "" } : {}));
  }
  if (allowed("project.view")) actions.push(running ? link("Open", `/projects/${encodeURIComponent(id)}`, { class: "primary" }) : button("Open", () => {}, { disabled: "", title: "Start the Project to open it" }));
  if (managesRuntime) {
    actions.push(button(running ? "Stop" : "Start", () => act(request(`${path}/${running ? "stop" : "start"}`, "POST", {}, undefined, 120), () => `${name} ${running ? "stopped" : "started"}.`), blocked && !running || deletion || (update || upgrading) ? { disabled: "" } : {}));
    actions.push(button("Restart", () => act(request(`${path}/restart`, "POST", {}, undefined, 120), () => `${name} restarted.`), blocked || status === "provisioning" ? { disabled: "" } : {}));
  }
  if (allowed("project.delete")) actions.push(button(deletion ? "Retry deletion" : "Delete", () => {
    if (window.confirm(deletion ? `Retry deletion of ${name}? This permanently removes the remaining project runtime, database, files, and metadata.` : `Delete ${name}? This permanently removes the project runtime, database, files, and metadata.`)) act(request(path, "DELETE", undefined, undefined, 120), () => `${name} was deleted.`);
  }, { class: "danger", ...(upgrading ? { disabled: "" } : {}) }));
  if (allowed("project.view") && canAccess(context.config.access, { permissions: ["assistant.use"] })) actions.push(link("Ask Assistant", `/assistant?project=${encodeURIComponent(id)}`, { "aria-label": `Ask Assistant about ${name}` }));
  body.push(node("div", { class: "actions" }, ...actions));
  return node("article", { class: "k-card" }, ...body);
}

function upgradeNotice(project: Record<string, unknown>, recipes: readonly Recipe[], act: (effect: Effect.Effect<unknown, ApiError>, done: (result: Record<string, unknown>) => string | undefined) => void, path: string, phaseNodes: Map<string, HTMLElement>) {
  const id = label(project.id, "");
  const runtime = object(project.runtime);
  const capabilities = object(project.capabilities);
  const status = object(project.recipeStatus);
  const activeUpgrade = project.upgrade ? object(project.upgrade) : undefined;
  const idle = runtime.status === "stopped" || runtime.status === "failed";
  const live = runtime.status === "running" && capabilities.zeroDowntimeUpdates === true;
  const integration = capabilities.recipeUpdateMode === "integration";
  const restarts = runtime.status === "running" && !live && !integration;
  const canUpgrade = idle || live || restarts;
  const upgrade = (recipeName?: string) => act(request(`${path}/upgrade`, "POST", { restart: true, async: true, ...(recipeName ? { recipeName } : {}) }), result => {
    const upgraded = object(result.project ?? result);
    const up = upgraded.upgrade ? object(upgraded.upgrade) : undefined;
    if (up?.state === "running" && typeof up.id === "string") {
      trackedUpgrades.set(id, { id: up.id, mode: "recipe" });
      return undefined;
    }
    return upgradeDoneMessage(upgraded, "recipe");
  });
  if (project.deletion) return node("div");
  if (activeUpgrade?.state === "running") {
    const phase = node("p", { class: "muted" }, typeof activeUpgrade.phase === "string" ? `${activeUpgrade.phase}…` : "Applying update…");
    phaseNodes.set(id, phase);
    return node("div", { class: "notice", "aria-label": "Project upgrade in progress" },
      node("strong", {}, "Upgrade in progress"),
      phase);
  }
  if (project.runtimeUpdate) {
    const update = object(project.runtimeUpdate);
    return node("div", { class: "notice", "aria-label": "Project update" }, node("strong", {}, update.error ? "Update recovery required" : "Update in progress"),
      ...(typeof update.error === "string" ? [node("p", { class: "danger" }, update.error), button("Retry update", () => upgrade())] : []));
  }
  const failedUpgrade = activeUpgrade?.state === "failed" && typeof activeUpgrade.error === "string" ? activeUpgrade.error : undefined;
  const layout = object(project.dataLayout);
  const needsAction = layout.state === "upgradeRequired" || status.state === "upgradeAvailable" || status.state === "unavailable";
  if (!needsAction && failedUpgrade) {
    return node("div", { class: "notice error", "aria-label": "Recipe upgrade failed" },
      node("strong", {}, "Upgrade failed"),
      node("p", {}, failedUpgrade));
  }
  const copy = layout.state === "upgradeRequired"
    ? `This app's Zelavis data uses an older layout (format ${label(layout.from)}), so it stays on its current Zelavis version. Updating migrates it to format ${label(layout.to)}, preserving your data and keeping a pre-upgrade backup under Project Settings if any data was present.${status.state === "upgradeAvailable" ? ` A newer recipe (${label(status.version)}) is applied with it.` : ""}`
    : status.state === "upgradeAvailable"
    ? integration
      ? `A newer recipe is available: ${label(status.version)}. Updates this app's Zelavis integration while its service keeps running. The app manages its own software updates.`
      : `A newer recipe is available: ${label(status.version)}. Upgrading keeps this Project's data${restarts ? " and restarts it, so it is unavailable for a short while" : ""}. The application's own software is not changed.`
    : `${label(status.reason, "")} Choose a recipe to move this Project to; its data is kept${restarts ? ", and it is restarted for the move" : ""}.`;
  const target = dropdown({ label: "Recipe to move to" }, recipes.map(recipe => ({ value: recipe.name, label: recipe.title })));
  const go = button(failedUpgrade ? "Retry update" : integration ? "Update recipe" : "Upgrade recipe", () => upgrade(status.state === "unavailable" ? target.value : undefined));
  if (!canUpgrade || status.state === "unavailable" && recipes.length === 0) go.setAttribute("disabled", "");
  return node("div", { class: failedUpgrade ? "notice error" : "notice", "aria-label": "Recipe upgrade" },
    ...(failedUpgrade ? [node("strong", {}, "Last upgrade failed"), node("p", {}, failedUpgrade)] : []),
    node("p", {}, copy), ...(status.state === "unavailable" ? [target] : []), go,
    ...(canUpgrade ? [] : [node("span", { class: "muted" }, "Wait for the Project to finish starting or stopping.")]));
}

function versionPanel(context: ScreenContext, project: Record<string, unknown>, path: string, act: (effect: Effect.Effect<unknown, ApiError>, done: (result: Record<string, unknown>) => string | undefined) => void, versions: Record<string, unknown>) {
  const id = label(project.id, "");
  const current = typeof versions.current === "string" ? versions.current : "";
  const choice = context.url.searchParams.get("engineVersion") ?? "";
  const upgrading = object(project.upgrade).state === "running";
  const blocked = !!project.deletion || !!project.runtimeUpdate || upgrading || versions.selectable !== true;
  const pick = select("version", "Zelavis version", [...(current ? [] : [["", "Choose a version"] as const]), ...array(versions.versions).map(object).map(entry => [label(entry.version, ""), `${label(entry.version)}${entry.status !== "available" ? " (unavailable)" : ""}`, entry.status !== "available"] as const)], choice || current);
  if (blocked) pick.setAttribute("disabled", "");
  pick.addEventListener("change", () => context.setSearch({ engineVersion: pick.value || undefined }));
  // A version that writes another data layout is never switched in place (the plain switch answers 409): the App is stopped, its
  // data migrated by the upgrade and the App started again on the chosen engine.
  const chosen = array(versions.versions).map(object).find(entry => entry.version === choice);
  const crossesLayout = typeof versions.currentDataFormat === "number" && typeof chosen?.dataFormat === "number" && chosen.dataFormat !== versions.currentDataFormat;
  const name = label(project.name);
  const apply = crossesLayout
    ? button("Stop, migrate and switch", () => {
      if (!window.confirm(`Stop ${name}, move its data from layout ${label(versions.currentDataFormat)} to ${label(chosen?.dataFormat)} and start it on Zelavis ${choice}? It is unavailable while this runs. A pre-upgrade backup is kept under Project Settings if any data was present.`)) return;
      context.run(request(`${path}/upgrade`, "POST", { engineVersion: choice, restart: true, async: true }), result => {
        const upgraded = object(object(result).project ?? result);
        const up = upgraded.upgrade ? object(upgraded.upgrade) : undefined;
        if (up?.state === "running" && typeof up.id === "string") {
          trackedUpgrades.set(id, { id: up.id, mode: "version" });
          context.setSearch({ versionProject: undefined, engineVersion: undefined });
          return;
        }
        setFlash(upgradeDoneMessage(upgraded, "version", choice));
        context.setSearch({ versionProject: undefined, engineVersion: undefined });
      });
    }, { class: "primary", ...(blocked ? { disabled: "" } : {}) })
    : button("Switch version", () => act(request(`${path}/version`, "POST", { version: pick.value }, undefined, 120), result => `${name} now uses Zelavis ${label(object(result.project).engineVersion, pick.value)}.`), { class: "primary", ...(blocked || !choice || choice === current ? { disabled: "" } : {}) });
  return node("div", { class: "notice", "aria-label": "App version" },
    node("p", {}, `Current Zelavis version: ${current || label(project.engineVersion, "Unavailable")}`),
    node("p", { class: "muted" }, crossesLayout
      ? `Zelavis ${choice} writes data layout ${label(chosen?.dataFormat)}, and this App's data is in layout ${label(versions.currentDataFormat)}. Switching stops the App, migrates its data (document versions and change history are kept) and starts it again.`
      : "Select an installed version and its matching App recipe. Project data is preserved."),
    ...(typeof versions.reason === "string" ? [node("p", {}, versions.reason)] : []), pick,
    node("div", { class: "actions" }, apply, button("Cancel", () => context.setSearch({ versionProject: undefined, engineVersion: undefined }))));
}
