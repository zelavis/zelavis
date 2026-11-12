import type { SwiperContainer } from "swiper/element";
import type { FuzorRouter } from "fuzor/runtime";
import { object, type Config, type Project } from "./api.ts";
import { backRow, button, link, node } from "./dom.ts";
import { ROOT } from "./mount.ts";
import { canAccess } from "./navigation-menu.ts";

const names = ["Home", "Notifications", "Assistant", "Search", "Account"] as const;
/** A second living Swiper owns utility depth; the main navigation/workspace remains mounted. */
export function createSidebarUtilities(router: FuzorRouter, onSignOut: () => void) {
  const view = document.createElement("swiper-container") as SwiperContainer;
  view.setAttribute("init", "false"); view.className = "sidebar-utilities"; view.setAttribute("aria-label", "Sidebar utilities"); view.hidden = true;
  const footer = document.querySelector<HTMLElement>("[data-shell-footer]")!;
  const cleanups: (() => void)[] = [];
  const slides = [0, 1, 2].map(() => { const slide = document.createElement("swiper-slide"); slide.className = "navigation-panel utility-panel"; view.append(slide); return slide; });
  let language = "en";
  let initialized = false, signature = "", projects: readonly Project[] = [], currentProject: string | undefined;
  const change = (utility?: string, panel?: string) => {
    const url = new URL(router.url());
    for (const [key, value] of [["sidebarUtility", utility], ["sidebarUtilityPanel", panel]] as const) { if (value) url.searchParams.set(key, value); else url.searchParams.delete(key); }
    void router.navigate(url.href, { focus: "preserve", scroll: "preserve" }).catch(console.error);
  };
  const controls = names.map(name => {
    const control = footer.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
    const activate = () => {
      if (name === "Home") void router.navigate(`${ROOT}/?sidebarView=menu`).catch(console.error);
      else change(name.toLowerCase());
    };
    control.addEventListener("click", activate);
    cleanups.push(() => control.removeEventListener("click", activate));
    return control;
  });
  view.id = "sidebar-utility-view";
  const branch = (title: string, panel: string) => button(title + " ›", () => change("account", panel), { class: "utility-link" });
  const entry = (title: string, path: string) => link(title, path, { class: "utility-link" });
  function renderRoot(name: string, config?: Config) {
    const body = node("nav", { "aria-label": `${name} shortcuts`, class: "utility-menu" });
    const allowed = (permission: string) => canAccess(config?.access, { permissions: [permission] });
    if (name === "notifications" && allowed("server.manage")) body.append(entry("Security checklist", "/server/security"), entry("Server logs", "/server/logs"), entry("Resource usage", "/server/resources"));
    if (name === "assistant" && allowed("assistant.use")) {
      const project = currentProject ?? projects[0]?.id;
      body.append(entry("Open chat", `/assistant${project ? `?project=${encodeURIComponent(project)}` : ""}`), node("strong", { class: "sidebar-label" }, "Projects"));
      for (const item of projects) body.append(entry(item.name, `/assistant?project=${encodeURIComponent(item.id)}`));
      if (allowed("projects.create")) body.append(entry("Build a project", "/projects?new=1"));
      if (allowed("system.services.manage")) body.append(entry("Inspect services", "/services"));
    }
    if (name === "search") {
      const input = node("input", { type: "search", name: "zelavis-sidebar-search", placeholder: "Search Zelavis", "aria-label": "Search Zelavis" });
      const results = node("div", { class: "utility-menu", "aria-live": "polite" });
      const destinations = [{ name: "Projects", path: "/projects" },
        ...(allowed("server.manage") ? [{ name: "Server", path: "/server" }] : []),
        ...(allowed("system.settings.manage") ? [{ name: "Settings", path: "/settings" }] : []),
        ...projects.map(item => ({ name: item.name, path: `/projects/${encodeURIComponent(item.id)}` }))];
      const filter = () => { const matches = destinations.filter(item => item.name.toLowerCase().includes(input.value.toLowerCase().trim())); results.replaceChildren(...matches.map(item => entry(item.name, item.path))); if (!matches.length) results.append(node("p", {}, "No matching destinations.")); };
      input.addEventListener("input", filter); filter(); body.append(input, results);
    }
    if (name === "account") {
      const access = object(config?.access), principal = object(access.principal);
      body.append(node("div", { class: "utility-account" }, node("small", {}, "Signed in"), node("strong", {}, typeof access.label === "string" ? `${access.label} dashboard` : "Runtime dashboard"), node("span", {}, typeof principal.id === "string" ? principal.id : "local project")), entry("Account overview", "/projects"),
        ...(allowed("system.settings.manage") ? [branch("Settings", "settings")] : []),
        button("Log out", onSignOut, { class: "utility-link" }));
    }
    return body;
  }
  function sync(list: readonly Project[], projectId?: string, config?: Config) {
    projects = list; currentProject = projectId;
    const url = new URL(router.url());
    const utility = url.searchParams.get("sidebarUtility") ?? "";
    controls[1].hidden = !canAccess(config?.access, { permissions: ["server.manage"] });
    controls[2].hidden = !canAccess(config?.access, { permissions: ["assistant.use"] });
    const active = names.findIndex(name => name.toLowerCase() === utility);
    const opened = active > 0 && !controls[active].hidden;
    controls.forEach((control, index) => { control.setAttribute("aria-pressed", String(index === (opened ? active : 0))); control.setAttribute("aria-expanded", String(opened && index === active)); });
    view.hidden = !opened;
    if (!opened) { signature = ""; return false; }
    const panel = utility === "account" && canAccess(config?.access, { permissions: ["system.settings.manage"] }) ? url.searchParams.get("sidebarUtilityPanel") : null;
    const depth = panel === "language" ? 2 : panel === "settings" ? 1 : 0;
    const next = JSON.stringify([utility, projectId, projects.map(item => [item.id, item.name]), config?.access]);
    if (next !== signature) {
      signature = next;
      const title = names[active];
      slides[0].replaceChildren(backRow(title, "navigation", () => change()), renderRoot(utility, config));
      slides[1].replaceChildren(backRow("Settings", "Account", () => change("account")), node("nav", { class: "utility-menu", "aria-label": "Account settings" }, entry("Global settings", "/settings"), entry("Appearance", "/settings/appearance"), entry("Runtime services", "/services"), branch("Language", "language")));
      const languages = node("div", { class: "utility-menu", role: "group", "aria-label": "Language preference" });
      for (const [code, label] of [["en", "English (United States)"], ["de", "Deutsch (Deutschland)"], ["sr", "Serbian (Srbija)"], ["es", "Spanish (Espana)"]]) {
        const choice = button(label, () => { language = code; for (const control of languages.querySelectorAll("button")) control.setAttribute("aria-pressed", String(control.dataset.language === code)); }, { class: "utility-link", "data-language": code, "aria-pressed": String(language === code) });
        languages.append(choice);
      }
      slides[2].replaceChildren(backRow("Language", "Settings", () => change("account", "settings")), languages, node("p", {}, "Preview preference only. Dashboard translations are not available yet."));
    }
    if (!initialized) { Object.assign(view, { slidesPerView: 1, speed: 300, simulateTouch: false, allowTouchMove: false, injectStyles: [":host,.swiper,.swiper-wrapper{height:100%;min-height:0}"] }); view.initialize(); initialized = true; }
    view.swiper.params.speed = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 300;
    view.swiper.update(); view.swiper.slideTo(depth);
    slides.forEach((slide, index) => { slide.inert = index !== depth; slide.setAttribute("aria-hidden", String(index !== depth)); });
    return true;
  }
  return { view, footer, sync, close: () => change(), dispose: () => { cleanups.forEach(clean => clean()); view.swiper?.destroy(true, true); } };
}
