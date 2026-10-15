import { Effect } from "effect";
import { ApiError, array, label, object, request } from "./api.ts";
import { button, field, link, node } from "./dom.ts";
import { card, dataRow, flashNotice, page, resourceNotice, rowsCard, setFlash } from "./page-kit.ts";
import type { ScreenContext } from "./screens.ts";

/** Settings: the dashboard's configuration, hostname onboarding, updates, the Assistant, and appearance. */

const PROVIDERS = [["openrouter", "OpenRouter", "vendor/model-name"], ["openai", "OpenAI", "gpt-…"], ["anthropic", "Anthropic", "claude-…"]] as const;
const SOURCES: Record<string, string> = {
  environment: "Set by the server environment",
  stored: "Saved in this dashboard",
  project: "This Project's own provider",
  platform: "Using the installation's provider",
  none: "Not configured"
};
const DECISIONS: Record<string, string> = { allowed: "Allowed", denied: "Denied", invalid: "Invalid request", failed: "Failed", pending_approval: "Asked for approval", executed: "Ran after approval" };

const forbidden = (error: ApiError) => error.status === 401 || error.status === 403;
const keepForbidden = <A>(effect: Effect.Effect<A, ApiError>) => effect.pipe(Effect.map(value => ({ value })), Effect.catch(error => forbidden(error) ? Effect.succeed({ hidden: true as const }) : Effect.fail(error)));

/** The Assistant's model provider, for the installation or (with `projectId`) one Project's own chats. The key is write-only. */
export const providerCard = Effect.fn("ui.assistantProvider")(function*(context: ScreenContext, projectId?: string) {
  const path = `${context.config.api.basePath}/runtime/assistant/${projectId ? `projects/${encodeURIComponent(projectId)}/` : ""}provider`;
  const loaded = yield* keepForbidden(request(path));
  if ("hidden" in loaded) return undefined;
  const status = object(loaded.value);
  const source = label(status.source, "none");
  const ownsKey = source === "stored" || source === "project";
  const environment = !projectId && source === "environment";
  const current = PROVIDERS.find(entry => entry[0] === status.provider);
  const summary = `${SOURCES[source] ?? source}${status.model && current ? ` · ${label(status.model)} via ${current[1]}` : ""}. ${status.mode === "local-router" ? "Without a model the Assistant only helps you navigate. " : ""}${projectId ? "A key saved here answers only this Project's chats. " : ""}The key is stored encrypted and is never shown again.`;
  const body: Node[] = [node("p", {}, summary)];
  if (environment) body.push(resourceNotice("Managed by the environment", "Unset ZELAVIS_ASSISTANT_API_KEY and restart to manage the provider here."));
  else {
    const provider = node("select", { name: "provider", "aria-label": "Provider" }, ...PROVIDERS.map(([id, title]) => node("option", { value: id, ...(id === (current?.[0] ?? "openrouter") ? { selected: "" } : {}) }, title)));
    const form = node("form", { class: "form", autocomplete: "off" },
      node("label", {}, node("span", {}, "Provider"), provider),
      field("model", "Model", "text", label(status.model, "")),
      node("label", {}, node("span", {}, "API key"), node("input", { name: "apiKey", type: "password", autocomplete: "new-password", required: "", placeholder: ownsKey ? "Enter a new key to replace the saved one" : "Paste the key" })),
      node("button", { type: "submit", class: "primary" }, "Save"));
    form.addEventListener("submit", event => {
      event.preventDefault();
      const data = new FormData(form);
      const apiKey = String(data.get("apiKey") ?? "");
      if (apiKey.length < 8) return;
      context.run(request(path, "PUT", { provider: String(data.get("provider")), model: String(data.get("model") ?? "").trim(), apiKey }), () => { setFlash("Provider saved. It applies to the next message."); context.refresh(); });
    });
    body.push(form);
    if (ownsKey) body.push(button("Remove", () => context.run(request(path, "DELETE"), () => { setFlash(projectId ? "This Project's provider was removed. Its chats use the installation's again." : "Provider removed. The built-in navigation helper answers again."); context.refresh(); })));
  }
  return card(projectId ? "Assistant model for this Project" : "Assistant model", ...body);
});

/** What the Assistant did, for whom, and what was decided; read-only, newest first, for those who may audit it. */
export const auditCard = Effect.fn("ui.assistantAudit")(function*(context: ScreenContext) {
  const before = context.url.searchParams.get("auditBefore") ?? "";
  const query = new URLSearchParams({ limit: "25", ...(before ? { before } : {}) });
  const loaded = yield* keepForbidden(request(`${context.config.api.basePath}/runtime/assistant/audit?${query}`));
  if ("hidden" in loaded) return undefined;
  const result = object(loaded.value);
  const records = array(result.records).map(object);
  const next = typeof result.next === "string" ? result.next : undefined;
  const table = node("div", { class: "table-wrap" }, node("table", { "aria-label": "Assistant activity" },
    node("thead", {}, node("tr", {}, ...["When", "Who", "What", "Outcome"].map(title => node("th", { scope: "col" }, title)))),
    node("tbody", {}, ...records.map(record => node("tr", {},
      node("td", {}, new Date(label(record.at, "")).toLocaleString()),
      node("td", {}, node("code", {}, label(record.principalId))),
      node("td", {}, node("code", {}, label(record.tool)), node("div", { class: "muted", title: label(record.arguments, "") }, label(record.arguments, ""))),
      node("td", {}, DECISIONS[label(record.decision, "")] ?? label(record.decision), ...(typeof record.reason === "string" ? [node("div", { class: "muted" }, record.reason)] : [])))))));
  return card("Assistant activity",
    ...(records.length ? [table] : [node("p", { class: "muted" }, "Nothing yet. Every tool the Assistant uses, and every decision on a change it asked for, is recorded here.")]),
    ...(before ? [button("Newest", () => context.setSearch({ auditBefore: undefined }))] : []),
    ...(next ? [button("Load older", () => context.setSearch({ auditBefore: next }))] : []));
});

export const settingsScreen = Effect.fn("ui.settingsScreen")(function*(context: ScreenContext) {
  if (context.path === "/settings/appearance") return yield* appearanceScreen(context);
  const api = context.config.api.basePath;
  const settings = object(yield* request(`${api}/runtime/settings`));
  const raw = object(yield* request(`${api}/runtime/config`));
  const engine = object(settings.runtimeEngine);
  const editable = object(settings.editable);
  const capabilities = Object.entries(object(raw.capabilities)).filter(([, value]) => object(value).available === true).map(([name]) => name).join(", ") || "none";
  const engines = array(engine.available).map(String);
  const rootPath = label(settings.pendingRootPath ?? settings.rootPath, "");
  const patch = (body: Record<string, unknown>, done: (saved: Record<string, unknown>) => string) => context.run(request(`${api}/runtime/settings`, "PATCH", body), saved => { setFlash(done(object(saved))); context.refresh(); });

  const engineSelect = node("select", { name: "engine", "aria-label": "Engine", ...(editable.runtimeEngine === true ? {} : { disabled: "" }) }, ...engines.map(name => node("option", { value: name, ...(name === engine.desired ? { selected: "" } : {}) }, name)));
  const engineForm = node("form", { class: "k-inline" }, node("label", {}, node("span", {}, "Engine"), engineSelect), node("button", { type: "submit", class: "primary", ...(editable.runtimeEngine === true ? {} : { disabled: "" }) }, "Save"));
  engineForm.addEventListener("submit", event => { event.preventDefault(); if (engineSelect.value === engine.desired) return; patch({ runtimeEngine: engineSelect.value }, saved => object(saved.runtimeEngine).restartRequired === true ? `Saved ${engineSelect.value}. Restart the runtime to switch engines.` : "Runtime engine saved."); });

  const pathInput = node("input", { name: "rootPath", value: rootPath, "aria-label": "Path", ...(editable.rootPath === true ? {} : { readonly: "" }) });
  const pathForm = node("form", { class: "k-inline", id: "dashboard-root-path-form" }, node("label", {}, node("span", {}, "Path"), pathInput), node("button", { type: "submit", class: "primary", ...(editable.rootPath === true ? {} : { disabled: "" }) }, "Save"));
  pathForm.addEventListener("submit", event => { event.preventDefault(); if (pathInput.value.trim() === rootPath) return; patch({ rootPath: pathInput.value }, saved => saved.restartRequired === true ? `Saved ${label(saved.pendingRootPath)}. Restart the runtime to apply the new root path.` : "Root path saved."); });

  const hostname = field("hostname", "Platform hostname", "text", "", false);
  const mode = node("select", { name: "mode", "aria-label": "HTTPS configuration" }, node("option", { value: "managed" }, "Verify DNS & enable HTTPS"), node("option", { value: "external" }, "Externally terminated TLS"), node("option", { value: "later" }, "Configure later"));
  const hostnameForm = node("form", { class: "form" }, hostname, node("label", {}, node("span", {}, "HTTPS configuration"), mode), node("button", { type: "submit", class: "primary" }, "Save hostname configuration"));
  const hostnameResult = node("div");
  hostnameForm.addEventListener("submit", event => {
    event.preventDefault();
    const name = String(new FormData(hostnameForm).get("hostname") ?? "").trim();
    context.run(request(`${api}/runtime/edge/onboard`, "POST", { mode: mode.value, ...(name ? { hostname: name } : {}) }), result => { hostnameResult.replaceChildren(node("pre", { class: "json" }, JSON.stringify(result, null, 2))); });
  });

  const updates = document.createElement("fuzor-island");
  updates.setAttribute("src", "update-card");
  const [provider, audit] = [yield* providerCard(context), yield* auditCard(context)];

  return page(
    flashNotice("Saved"),
    ...(context.url.searchParams.get("onboarding") === "hostname" ? [resourceNotice("Your owner account is active", "Configure a Platform hostname now, or continue and configure it later.")] : []),
    rowsCard("Configuration",
      dataRow("Root path", label(settings.rootPath)),
      dataRow("API prefix", label(settings.apiBasePath)),
      dataRow("Runtime config", label(raw.configSource, "checking")),
      dataRow("Runtime engine", engine.restartRequired === true ? `${label(engine.current)} now, ${label(engine.desired)} after restart` : label(engine.current)),
      dataRow("Native capabilities", capabilities)),
    card("Runtime Engine", engineForm, ...(engine.restartRequired === true ? [resourceNotice("Restart required", `The active runtime is ${label(engine.current)}. The pending runtime engine is ${label(engine.desired)}.`)] : [])),
    card("Root Path", pathForm, ...(settings.restartRequired === true ? [resourceNotice("Restart required", `The active dashboard is still served from ${label(settings.rootPath)}. The pending root path is ${label(settings.pendingRootPath)}.`)] : [])),
    card("Platform hostname", node("p", {}, "The address of this dashboard and its API."), hostnameForm, hostnameResult),
    updates,
    provider,
    audit,
    rowsCard("Appearance", dataRow("Persistence", settings.persistence === "read-only" ? "Read-only until runtime settings storage is available." : "Runtime settings storage is available. Root path changes apply after restart."), dataRow("Theme", "Configure dashboard light, dark, or system mode.", link("Open", "/settings/appearance"))),
    rowsCard("Runtime Services", dataRow("Mounted services", "Inspect core services and service-provided runtime pieces registered in this runtime.", link("Open", "/services"))));
});

const THEMES = [["auto", "System"], ["light", "Light"], ["dark", "Dark"]] as const;

export const appearanceScreen = Effect.fn("ui.appearanceScreen")(function*(context: ScreenContext) {
  const api = context.config.api.basePath;
  const settings = object(yield* request(`${api}/runtime/settings`));
  const stored = Effect.runSync(Effect.try({ try: () => localStorage.getItem("theme"), catch: cause => cause }).pipe(Effect.orElseSucceed(() => null)));
  const current = THEMES.some(([id]) => id === stored) ? String(stored) : label(settings.theme, "auto");
  const select = node("select", { name: "theme", "aria-label": "Theme" }, ...THEMES.map(([id, title]) => node("option", { value: id, ...(id === current ? { selected: "" } : {}) }, title)));
  select.addEventListener("change", () => {
    const mode = select.value;
    Effect.runSync(Effect.try({ try: () => localStorage.setItem("theme", mode), catch: cause => cause }).pipe(Effect.catch(cause => Effect.logWarning("Could not remember the theme in this browser", cause))));
    document.documentElement.dataset.dashboardTheme = mode === "auto" ? matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" : mode;
    if (object(settings.editable).theme === true) context.run(request(`${api}/runtime/settings`, "PATCH", { theme: mode }), () => {});
  });
  const description = settings.persistence === "runtime" ? "The project default comes from the runtime. This browser can still override it locally." : "The setting is stored locally and can follow your system preference.";
  return page(
    card("Theme", node("p", {}, "Choose how the Zelavis dashboard should render for this project."), node("label", {}, node("span", {}, "Mode"), select), node("p", { class: "muted" }, description)),
    card("Preview", node("p", {}, "The preview uses the active dashboard tokens. Surface, border, accent, and text colors stay neutral in both light and dark mode."), node("div", { class: "k-row-meta" }, node("span", { class: "k-badge" }, "Dashboard control"))));
});

export const servicesScreen = Effect.fn("ui.servicesScreen")(function*(context: ScreenContext) {
  const services = array(context.config.services).map(object);
  return page(rowsCard("Mounted runtime pieces", ...(services.length
    ? services.map(service => dataRow(label(service.name), `${label(service.scope, "extension")} ${label(service.kind, "plugin")} package · ${label(service.apiPath)}`, node("span", { class: "k-badge good" }, "ready")))
    : [resourceNotice("Runtime config unavailable", "The dashboard config endpoint could not be loaded.")])));
});
