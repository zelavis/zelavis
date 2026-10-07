import { register } from "swiper/element/bundle";
import type { SwiperContainer } from "swiper/element";
import type { FuzorRouter } from "fuzor/runtime";
import { type Config, type Project } from "./api.ts";
import { button, link, node } from "./dom.ts";
import type { DashboardHandle } from "./routes.ts";

import { panelsFor, resolveTrail, type Panel } from "./navigation-model.ts";

export function createSidebar(host: HTMLElement, sidebar: HTMLElement, content: HTMLElement, main: HTMLElement, router: FuzorRouter) {
  register();
  const media = matchMedia("(max-width: 1023px)");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const swiper = document.createElement("swiper-container") as SwiperContainer;
  swiper.setAttribute("init", "false"); swiper.setAttribute("aria-label", "Platform navigation");
  const mobileSlide = document.createElement("swiper-slide"); mobileSlide.className = "mobile-workspace";
  const mobileTitle = node("span");
  mobileSlide.append(node("div", { class: "panel-heading" }, button("← Menu", () => showMenu(), { "aria-label": "Back to navigation" }), mobileTitle));
  sidebar.append(link("◈ Zelavis", "/", { class: "brand" }), node("div", { class: "sidebar-label" }, "THE APP PLATFORM"), swiper, node("div", { class: "sidebar-footer" }, node("span", { class: "runtime-dot" }), "Local Platform", node("small", {}, "Built with Fuzor · pre-alpha")));
  let auth = false;
  let projectList: readonly Project[] = [];
  let trail: Panel[] = [];
  let synchronizing = false;
  let initialized = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let snapshot: { path: string; projectId?: string; project?: Project; runtime?: Config; menu?: unknown } = { path: "/" };
  const slides: HTMLElement[] = [];
  const navigate = (path: string, ids: readonly string[], view: "menu" | "content") => {
    const url = new URL(`/zelavis${path === "/" ? "/" : path}`, location.href);
    url.searchParams.set("sidebar", ids.join("/"));
    if (media.matches) url.searchParams.set("sidebarView", view);
    void router.navigate(url.href).catch(console.error);
  };
  function showMenu() {
    const url = new URL(router.url()); url.searchParams.set("sidebarView", "menu");
    void router.navigate(url.href, { focus: "preserve", scroll: "preserve" }).catch(console.error);
  }
  function sync(path: string, projectId?: string, project?: Project, runtime?: Config, menu?: unknown) {
    snapshot = { path, projectId, project, runtime, menu };
    const panels = panelsFor(projectId, project, runtime, menu, projectList);
    const matches = router.matches();
    const handle = matches.at(-1)?.handle as DashboardHandle | undefined;
    const url = new URL(router.url());
    // While the exact Project is loading, retain its route-declared panels; capability filtering follows the response.
    let next = resolveTrail(panels, handle?.sidebarTrail ?? [], url.searchParams.get("sidebar"));
    if (!project && projectId && handle?.sidebarTrail?.length && url.searchParams.get("sidebar") === null) next = resolveTrail(panels, handle.sidebarTrail.slice(0, 2), null);
    const previousDepth = trail.length;
    trail = next;
    mobileTitle.textContent = handle?.pageLabel ?? "Workspace";
    if (timer) clearTimeout(timer);
    synchronizing = true;
    // Reuse the container and each depth's slide so route changes animate in one living shell.
    trail.forEach((panel, index) => {
      let slide = slides[index];
      if (!slide) { slide = document.createElement("swiper-slide"); slide.className = "navigation-panel"; slides.push(slide); swiper.insertBefore(slide, mobileSlide.parentNode === swiper ? mobileSlide : null); }
      const nav = node("nav", { "aria-label": `${panel.label} navigation` });
      panel.items.forEach(item => {
        const destination = new URL(`/zelavis${item.path === "/" ? "/" : item.path}`, location.href);
        const ids = trail.slice(1, index + 1).map(panel => panel.id);
        if (item.branch) ids.push(item.branch);
        destination.searchParams.set("sidebar", ids.join("/"));
        if (media.matches) destination.searchParams.set("sidebarView", item.branch ? "menu" : "content");
        const itemPath = destination.pathname.replace(/^\/zelavis/, "").replace(/\/+$/, "") || "/";
        const selected = ["databaseTenant", "databaseTable", "databaseSystemView"];
        const matchesSearch = selected.every(key => destination.searchParams.get(key) === url.searchParams.get(key));
        const active = (path === itemPath && matchesSearch) || Boolean(item.branch && path.startsWith(`${itemPath}/`) && itemPath !== "/");
        const anchor = node("a", { href: `${destination.pathname}${destination.search}`, ...(active ? { class: "active", "aria-current": "page" } : {}) }, item.label, item.branch ? node("span", { "aria-hidden": "true", class: "chevron" }, "›") : undefined);
        nav.append(anchor);
      });
      slide.replaceChildren(node("div", { class: "panel-heading" }, index ? button(`← ${panel.label}`, () => navigate(trail[index - 1].path, trail.slice(1, index).map(panel => panel.id), "menu"), { "aria-label": `Back to ${trail[index - 1].label}` }) : node("strong", {}, "Platform")), nav);
    });
    const trim = () => { while (slides.length > trail.length) slides.pop()!.remove(); swiper.swiper?.update(); };
    // Outgoing panels stay present until Back has animated to its parent.
    if (previousDepth > trail.length && initialized) timer = setTimeout(() => { synchronizing = true; trim(); if (media.matches && new URL(router.url()).searchParams.get("sidebarView") !== "menu") swiper.swiper.slideTo(trail.length, 0); synchronizing = false; }, reduced.matches ? 0 : 310); else trim();
    if (media.matches) { if (mobileSlide.parentNode !== swiper) swiper.append(mobileSlide); if (content.parentNode !== mobileSlide) mobileSlide.append(content); } else { mobileSlide.remove(); if (content.parentNode !== main) main.append(content); }
    if (!initialized) {
      Object.assign(swiper, { slidesPerView: 1, speed: reduced.matches ? 0 : 300, allowTouchMove: media.matches, injectStyles: [":host{height:100%;min-height:0}.swiper{height:100%}.swiper-wrapper{height:100%}"] });
      swiper.initialize(); initialized = true;
    }
    swiper.swiper.allowTouchMove = media.matches;
    swiper.swiper.params.speed = reduced.matches ? 0 : 300;
    swiper.swiper.update();
    const contentVisible = media.matches && url.searchParams.get("sidebarView") !== "menu";
    const index = contentVisible ? slides.length : trail.length - 1;
    swiper.swiper.slideTo(index, initialized && previousDepth ? undefined : 0);
    Array.from(swiper.children).forEach((slide, position) => { const inactive = position !== index; slide.setAttribute("aria-hidden", String(inactive)); (slide as HTMLElement).inert = inactive; });
    host.classList.toggle("mobile-content", contentVisible);
    synchronizing = false;
  }
  const changed = () => {
    if (synchronizing || !media.matches) return;
    const index = swiper.swiper.activeIndex;
    if (index >= trail.length) { const url = new URL(router.url()); url.searchParams.set("sidebarView", "content"); void router.navigate(url.href).catch(console.error); }
    else if (index === trail.length - 1) showMenu();
    else if (trail[index]) navigate(trail[index].path, trail.slice(1, index + 1).map(panel => panel.id), "menu");
  };
  swiper.addEventListener("swiperslidechange", changed);
  const resized = () => { if (auth && content.parentNode !== main) main.append(content); else sync(snapshot.path, snapshot.projectId, snapshot.project, snapshot.runtime, snapshot.menu); };
  media.addEventListener("change", resized); reduced.addEventListener("change", resized);
  return { sync, showMenu, setProjects(list: readonly Project[]) { projectList = list; resized(); }, setAuth(value: boolean) { auth = value; if (auth && content.parentNode !== main) main.append(content); }, dispose() { if (timer) clearTimeout(timer); media.removeEventListener("change", resized); reduced.removeEventListener("change", resized); swiper.removeEventListener("swiperslidechange", changed); swiper.swiper?.destroy(true, true); } };
}
