import { Effect } from "effect";
import { array, label, object, request, type Config } from "./api.ts";
import { button, empty, link, node } from "./dom.ts";
import { badge, card, facts, flashNotice, page, resourceNotice, setFlash } from "./page-kit.ts";
import type { ScreenContext } from "./screens.ts";

/**
 * The Marketplace: one workspace in two places. The Platform's (`/marketplace`) and a Project's
 * (`/projects/:projectId/marketplace`) differ only in what the scope allows, never in how they look.
 */
export type MarketplaceScope = "platform" | "project";
const TABS = [["apps", "Apps", "app"], ["frontends", "Frontends", "frontend"], ["plugins", "Plugins", "plugin"]] as const;
type Tab = (typeof TABS)[number][0];

const INTRO: Record<Tab, string> = {
  apps: "Ready-made apps. Create a new Project from one with a single click.",
  frontends: "The face of a Project. Swapping it leaves the Project's data untouched.",
  plugins: "Extend Zelavis with capabilities, providers and integrations."
};
const EMPTY: Record<Tab, string> = { apps: "No apps are available yet.", frontends: "No frontends are available yet.", plugins: "No plugins are available yet." };
const ORIGIN: Record<string, string> = { remote: "fetched just now", cache: "fetched from a source", bundled: "shipped with this release" };

/** The Platform's own frontend is the dashboard; switching it would let an operator disable the official one. */
const disabledReason = (tab: Tab, scope: MarketplaceScope) => tab === "frontends" && scope === "platform"
  ? "The Zelavis dashboard's own frontend cannot be switched, so it cannot be disabled by installing another. Open a Project's Marketplace to choose that Project's frontend."
  : undefined;

const titleOf = (service: Record<string, unknown>) => label(object(service.marketplace).title ?? object(service.menu).title ?? service.name);
const maintainerOf = (service: Record<string, unknown>) => !service.maintainer ? "Community" : service.maintainer === "zelavis" ? "Zelavis" : label(service.maintainer);

/** What a tab lists: installed first, then by declared order, then by name. */
export function selectItems(registry: readonly unknown[], tab: Tab, query = "") {
  const kind = TABS.find(entry => entry[0] === tab)![2];
  const needle = query.trim().toLowerCase();
  return registry.map(object)
    .filter(service => service.kind === kind && (tab === "apps" || service.scope !== "system"))
    .filter(service => !needle || [service.name, titleOf(service), object(service.marketplace).summary, ...array(object(service.marketplace).tags), ...array(object(service.marketplace).categories)].filter((value): value is string => typeof value === "string").some(value => value.toLowerCase().includes(needle)))
    .sort((left, right) => Number(right.status === "installed") - Number(left.status === "installed") || (Number(left.order ?? 1000) - Number(right.order ?? 1000)) || titleOf(left).localeCompare(titleOf(right)));
}

const tile = (service: Record<string, unknown>, large = false) => {
  let hash = 0;
  for (const character of label(service.name, "")) hash = (hash * 31 + character.charCodeAt(0)) % 360;
  return node("span", { "aria-hidden": "true", class: `mk-tile${large ? " large" : ""}`, style: `background-color:oklch(0.94 0.05 ${hash});color:oklch(0.42 0.13 ${hash})` }, titleOf(service).charAt(0).toUpperCase());
};

const installService = (api: string, service: Record<string, unknown>) => service.installVia === "acquire"
  ? request(`${api}/runtime/services`, "POST", { packageSource: `npm:${label(service.name)}@${label(service.version)}`, status: "installed" })
  : request(`${api}/runtime/services/${encodeURIComponent(label(service.name, ""))}`, "PATCH", { status: "installed" });

const dateText = (value: unknown) => { const date = new Date(label(value, "")); return Number.isNaN(date.getTime()) ? label(value) : date.toLocaleDateString(); };

export const marketplaceScreen = Effect.fn("ui.marketplaceScreen")(function*(context: ScreenContext, scope: MarketplaceScope, scoped?: Config) {
  const control: Config = context.config;
  const runtime: Config = scoped ?? control;
  const params = context.url.searchParams;
  const requested = TABS.find(entry => entry[0] === params.get("tab"))?.[0];
  const tab: Tab = requested && !disabledReason(requested, scope) ? requested : "apps";
  const query = params.get("q") ?? "";
  const registry = array(runtime.serviceRegistry);
  const appRegistry = array(control.serviceRegistry);
  const registryFor = (entry: Tab) => entry === "apps" ? appRegistry : registry;
  const items = selectItems(registryFor(tab), tab, query);
  const counts = Object.fromEntries(TABS.map(([id]) => [id, selectItems(registryFor(id), id).length]));
  const allowlist = yield* request(`${control.api.basePath}/runtime/marketplace/allowlist`).pipe(Effect.map(object), Effect.catch(() => Effect.succeed(undefined)));

  const done = (text: string) => { setFlash(text); context.refresh(); };
  const install = (service: Record<string, unknown>) => context.run(installService(runtime.api.basePath, service), () => done(`Installed ${titleOf(service)}.`));
  const update = (service: Record<string, unknown>) => context.run(request(`${(tab === "apps" ? control : runtime).api.basePath}/runtime/services/${encodeURIComponent(label(service.name, ""))}/update`, "POST", {}), result => done(tab === "apps" ? `Updated ${titleOf(service)} to ${label(object(object(result).service).version)}. Its Projects now offer the upgrade.` : `Updated ${titleOf(service)} to ${label(object(object(result).service).version)}.`));
  const startCreate = (service: Record<string, unknown>) => context.setSearch({ create: label(service.name, "") });

  const tabs = node("div", { role: "tablist", "aria-label": "Marketplace sections", class: "actions" }, ...TABS.map(([id, title]) => {
    const reason = disabledReason(id, scope);
    const text = `${title} ${counts[id]}`;
    if (reason) return node("span", { role: "tab", "aria-selected": "false", "aria-disabled": "true", title: reason, class: "mk-tab disabled" }, text);
    return link(text, `${context.path}${id === "apps" ? "" : `?tab=${id}`}`, { role: "tab", "aria-selected": String(id === tab), class: `mk-tab${id === tab ? " active" : ""}` });
  }));
  const search = node("input", { type: "search", name: "q", value: query, placeholder: `Search ${TABS.find(entry => entry[0] === tab)![1].toLowerCase()}…`, "aria-label": "Search the marketplace" });
  const searchForm = node("form", { role: "search" }, search);
  searchForm.addEventListener("submit", event => { event.preventDefault(); context.setSearch({ q: search.value || undefined }); });

  const sections: (Node | undefined)[] = [flashNotice("Marketplace"), node("div", { class: "toolbar" }, tabs, searchForm), node("p", { class: "muted" }, INTRO[tab])];

  if (allowlist) {
    const list = allowlist.list ? object(allowlist.list) : undefined;
    const refresh = button("Refresh", () => context.run(request(`${control.api.basePath}/runtime/marketplace/allowlist/refresh`, "POST"), result => {
      const report = object(result);
      const attempts = array(report.attempts).map(object);
      const failed = attempts.filter(attempt => attempt.outcome !== "ok");
      done(report.updated === true ? `Allow-list updated to list ${label(object(report.list).sequence)}.` : failed.length && failed.length === attempts.length ? `Could not reach a source: ${label(failed[0].detail ?? failed[0].outcome)}` : "The allow-list is already the newest.");
    }));
    sections.push(node("div", { class: "k-notice mk-allowlist", "aria-label": "Allow-list" },
      node("strong", {}, allowlist.gated === true ? "Installs are limited to the allow-list" : "Allow-list gate is off"),
      ...(list ? [node("span", {}, `List ${label(list.sequence)}`), badge(label(list.status)), node("span", {}, ORIGIN[label(list.origin, "")] ?? label(list.origin)), node("span", {}, `issued ${dateText(list.issuedAt)}`), node("span", {}, `expires ${dateText(list.expiresAt)}`)] : [node("span", {}, "No list is held")]),
      Number(allowlist.sources) > 0 ? refresh : node("span", {}, "No sources configured")));
  }

  const creating = params.get("create") ? appRegistry.map(object).find(service => service.name === params.get("create")) : undefined;
  if (creating) {
    const name = node("input", { name: "name", value: params.get("name") ?? `My ${titleOf(creating)}`, required: "", "aria-label": "Project name", autocomplete: "off" });
    const submit = node("button", { type: "submit", class: "primary" }, "Create project");
    const form = node("form", { class: "form" }, node("p", {}, creating.status === "available" ? "It is installed first, then the new Project starts in its own runtime." : "The new Project starts in its own runtime."), node("label", {}, node("span", {}, "Project name"), name),
      node("div", { class: "actions" }, submit, button("Cancel", () => context.setSearch({ create: undefined, name: undefined }))));
    form.addEventListener("submit", event => {
      event.preventDefault();
      const projectName = name.value.trim();
      if (!projectName) return;
      const hostPackages = array(object(creating.project).hostPackages);
      // A recipe that is not installed yet is installed first, so the one click is the whole job.
      const work = Effect.gen(function*() {
        if (creating.status === "available") yield* installService(control.api.basePath, creating);
        if (hostPackages.length) return { approve: true as const };
        const created = object(yield* request(`${control.api.basePath}/runtime/projects`, "POST", { name: projectName, recipeName: label(creating.name, ""), start: true }));
        return { approve: false as const, id: label(object(created.project).id, "") };
      });
      context.run(work, outcome => {
        if (outcome.approve) context.navigate(`/projects?${new URLSearchParams({ new: "1", recipe: label(creating.name, ""), name: projectName })}`);
        else context.navigate(`/projects/${encodeURIComponent(outcome.id)}`);
      });
    });
    sections.push(card(`Create a ${titleOf(creating)} project`, form));
  }

  if (items.length === 0) sections.push(empty(query ? "Nothing matches that search." : EMPTY[tab], ""));
  else sections.push(node("ul", { class: "k-grid cols-3 mk-list", "aria-label": TABS.find(entry => entry[0] === tab)![1] }, ...items.map(service => {
    const installed = service.status === "installed";
    const updateTo = service.update ? label(object(service.update).version) : undefined;
    const controls: HTMLElement[] = [button("More details", () => context.setSearch({ details: label(service.name, "") }))];
    if (updateTo && tab !== "apps") controls.push(button(`Update to ${updateTo}`, () => update(service)));
    if (tab !== "apps" && installed) controls.push(badge("Installed"));
    else controls.push(button(tab === "apps" ? "Create project" : "Install", () => tab === "apps" ? startCreate(service) : install(service), { class: "primary" }));
    return node("li", { class: "k-card" },
      node("div", { class: "mk-head" }, tile(service), node("div", {}, node("h3", {}, titleOf(service)), node("p", { class: "muted" }, `By ${maintainerOf(service)}${service.version ? ` · v${label(service.version)}` : ""}`))),
      node("p", {}, label(object(service.marketplace).summary, "No description provided.")),
      node("div", { class: "actions" }, ...controls));
  })));

  const selected = params.get("details") ? registryFor(tab).map(object).find(service => service.name === params.get("details")) : undefined;
  if (selected) {
    const marketplace = object(selected.marketplace);
    const kinds = array(object(selected.project).runtimeKinds).map(String);
    const categories = array(marketplace.categories).map(String);
    const tags = array(marketplace.tags).map(String);
    sections.push(card(undefined,
      node("div", { class: "mk-head" }, tile(selected, true), node("div", {}, node("h2", {}, titleOf(selected)), node("p", { class: "muted" }, `By ${maintainerOf(selected)}`))),
      node("p", {}, label(marketplace.description ?? marketplace.summary, "No description provided.")),
      facts([["Package", label(selected.name)], ...(selected.version ? [["Version", label(selected.version)] as const] : []), ["Status", label(selected.status)], ...(kinds.length ? [["Runs on", kinds.join(", ")] as const] : []), ...(categories.length ? [["Categories", categories.join(", ")] as const] : []), ...(tags.length ? [["Tags", tags.join(", ")] as const] : [])]),
      node("div", { class: "actions" },
        ...(tab === "apps" || selected.status === "available" ? [button(tab === "apps" ? "Create project" : "Install", () => tab === "apps" ? startCreate(selected) : install(selected), { class: "primary" })] : []),
        button("Close", () => context.setSearch({ details: undefined })))));
  }
  return page(...sections);
});
