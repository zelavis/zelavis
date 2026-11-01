import type { SwiperContainer } from "swiper/element";
import type { FuzorRouter } from "fuzor/runtime";
import { object, type Config, type Project } from "./api.ts";
import { backRow, button, link, node } from "./dom.ts";
import { ROOT } from "./mount.ts";

const names = ["Home", "Notifications", "Assistant", "Search", "Account"] as const;
const paths = [
  "M3 10 12 3l9 7v10h-6v-6H9v6H3Z",
  "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4",
  "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z",
  "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  "M20 21v-2a8 8 0 0 0-16 0v2M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
];
function icon(path: string) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(key, value);
  const shape = document.createElementNS(svg.namespaceURI, "path"); shape.setAttribute("d", path); svg.append(shape); return svg;
}

/** A second living Swiper owns utility depth; the main navigation/workspace remains mounted. */
export function createSidebarUtilities(router: FuzorRouter, onSignOut: () => void) {
  const view = document.createElement("swiper-container") as SwiperContainer;
  view.setAttribute("init", "false"); view.className = "sidebar-utilities"; view.setAttribute("aria-label", "Sidebar utilities"); view.hidden = true;
  const footer = node("nav", { class: "sidebar-footer sidebar-switches", "aria-label": "Sidebar view switches" });
  const slides = [0, 1, 2].map(() => { const slide = document.createElement("swiper-slide"); slide.className = "navigation-panel utility-panel"; view.append(slide); return slide; });
  let language = "en";
  let initialized = false, signature = "", projects: readonly Project[] = [], currentProject: string | undefined;
  const change = (utility?: string, panel?: string) => {
    const url = new URL(router.url());
    for (const [key, value] of [["sidebarUtility", utility], ["sidebarUtilityPanel", panel]] as const) { if (value) url.searchParams.set(key, value); else url.searchParams.delete(key); }
    void router.navigate(url.href, { focus: "preserve", scroll: "preserve" }).catch(console.error);
  };
  const controls = names.map((name, index) => {
    const control = button("", () => {
      if (name === "Home") {
        void router.navigate(`${ROOT}/?sidebar=&sidebarView=menu`).catch(console.error);
      } else change(name.toLowerCase());
    }, { class: "sidebar-switch", "aria-label": name, title: name, "aria-controls": "sidebar-utility-view" });
    control.append(icon(paths[index])); footer.append(control); return control;
  });
  view.id = "sidebar-utility-view";
  const branch = (title: string, panel: string) => button(title + " ›", () => change("account", panel), { class: "utility-link" });
  const entry = (title: string, path: string) => link(title, path, { class: "utility-link" });
  function renderRoot(name: string, config?: Config) {
    const body = node("nav", { "aria-label": `${name} shortcuts`, class: "utility-menu" });
    if (name === "notifications") body.append(entry("Security checklist", "/server/security"), entry("Server logs", "/server/logs"), entry("Resource usage", "/server/resources"));
    if (name === "assistant") {
      const project = currentProject ?? projects[0]?.id;
      body.append(entry("Open chat", `/assistant${project ? `?project=${encodeURIComponent(project)}` : ""}`), node("strong", { class: "sidebar-label" }, "Projects"));
      for (const item of projects) body.append(entry(item.name, `/assistant?project=${encodeURIComponent(item.id)}`));
      body.append(entry("Build a project", "/projects?new=1"), entry("Inspect services", "/services"));
    }
    if (name === "search") {
      const input = node("input", { type: "search", name: "zelavis-sidebar-search", placeholder: "Search Zelavis", "aria-label": "Search Zelavis" });
      const results = node("div", { class: "utility-menu", "aria-live": "polite" });
      const destinations = [{ name: "Projects", path: "/projects" }, { name: "Server", path: "/server" }, { name: "Settings", path: "/settings" }, ...projects.map(item => ({ name: item.name, path: `/projects/${encodeURIComponent(item.id)}` }))];
      const filter = () => { const matches = destinations.filter(item => item.name.toLowerCase().includes(input.value.toLowerCase().trim())); results.replaceChildren(...matches.map(item => entry(item.name, item.path))); if (!matches.length) results.append(node("p", {}, "No matching destinations.")); };
      input.addEventListener("input", filter); filter(); body.append(input, results);
    }
    if (name === "account") {
      const access = object(config?.access), principal = object(access.principal);
      body.append(node("div", { class: "utility-account" }, node("small", {}, "Signed in"), node("strong", {}, typeof access.label === "string" ? `${access.label} dashboard` : "Runtime dashboard"), node("span", {}, typeof principal.id === "string" ? principal.id : "local project")), entry("Account overview", "/projects"), branch("Settings", "settings"), button("Log out", onSignOut, { class: "utility-link" }));
    }
    return body;
  }
  function sync(list: readonly Project[], projectId?: string, config?: Config) {
    projects = list; currentProject = projectId;
    const url = new URL(router.url());
    const utility = url.searchParams.get("sidebarUtility") ?? "";
    const active = names.findIndex(name => name.toLowerCase() === utility);
    const opened = active > 0;
    controls.forEach((control, index) => { control.setAttribute("aria-pressed", String(index === (opened ? active : 0))); control.setAttribute("aria-expanded", String(opened && index === active)); });
    view.hidden = !opened;
    if (!opened) { signature = ""; return false; }
    const panel = utility === "account" ? url.searchParams.get("sidebarUtilityPanel") : null;
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
  return { view, footer, sync, close: () => change(), dispose: () => view.swiper?.destroy(true, true) };
}
