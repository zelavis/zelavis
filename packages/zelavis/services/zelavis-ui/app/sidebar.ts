import { createSidebarUtilities } from "./sidebar-utilities.ts";
import { register } from "swiper/element/bundle";
import type { SwiperContainer } from "swiper/element";
import type { FuzorRouter } from "fuzor/runtime";
import { type Config, type Project } from "./api.ts";
import { backRow, button, link, node } from "./dom.ts";
import type { DashboardHandle } from "./routes.ts";

import { createMenuStore, itemIsActive, panelsFor, resolveTrail, workspacePanels, trailForLocation, type Panel } from "./navigation-model.ts";
import { mounted, unmounted } from "./mount.ts";

/**
 * A label wider than its row ends in an ellipsis. Where a pointer hovers (or the keyboard focuses) the row, and motion is
 * allowed, the text slides to show its end and back; the full name is also the link's title, and touch screens, which cannot
 * hover, wrap it over two lines instead (styles.css).
 */
function revealOverflow(nav: HTMLElement) {
  const hover = matchMedia("(hover: hover)"), reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const running = new WeakMap<HTMLElement, Animation>();
  const slide = (anchor: HTMLElement, forward: boolean) => {
    const label = anchor.querySelector<HTMLElement>(".nav-label"), text = anchor.querySelector<HTMLElement>(".nav-text");
    if (!label || !text) return;
    const current = running.get(text);
    if (!forward) { current?.cancel(); running.delete(text); label.classList.remove("sliding"); return; }
    if (!hover.matches || reduced.matches) return;
    // Inline text only ends in an ellipsis while it is inline; it becomes a block to slide, so measure before that.
    const overflow = Math.ceil(label.scrollWidth - label.clientWidth);
    if (overflow <= 0 || current) return;
    label.classList.add("sliding");
    running.set(text, text.animate([{ transform: "translateX(0)" }, { transform: "translateX(0)", offset: 0.15 }, { transform: `translateX(-${overflow}px)`, offset: 0.85 }, { transform: `translateX(-${overflow}px)` }], { duration: Math.min(6000, 1400 + overflow * 25), iterations: Infinity, direction: "alternate", easing: "ease-in-out" }));
  };
  const anchorOf = (event: Event) => (event.target as HTMLElement | null)?.closest<HTMLElement>("a");
  nav.addEventListener("mouseover", event => { const anchor = anchorOf(event); if (anchor && !anchor.contains(event.relatedTarget as Node | null)) slide(anchor, true); });
  nav.addEventListener("mouseout", event => { const anchor = anchorOf(event); if (anchor && !anchor.contains(event.relatedTarget as Node | null)) slide(anchor, false); });
  nav.addEventListener("focusin", event => { const anchor = anchorOf(event); if (anchor) slide(anchor, true); });
  nav.addEventListener("focusout", event => { const anchor = anchorOf(event); if (anchor) slide(anchor, false); });
}

export function createSidebar(host: HTMLElement, sidebar: HTMLElement, content: HTMLElement, main: HTMLElement, router: FuzorRouter, options: { onSignOut: () => void; config: () => Config | undefined }) {
  register();
  const media = matchMedia("(max-width: 1023px)");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const swiper = document.createElement("swiper-container") as SwiperContainer;
  swiper.setAttribute("init", "false"); swiper.setAttribute("aria-label", "Platform navigation");
  const mobileSlide = document.createElement("swiper-slide"); mobileSlide.className = "mobile-workspace";
  const mobileHeading = backRow("Workspace", "navigation", () => showMenu());
  const mobileTitle = mobileHeading.querySelector<HTMLElement>(".back-title")!;
  mobileSlide.append(mobileHeading);
  const utilities = createSidebarUtilities(router, options.onSignOut);
  sidebar.append(link("◈ Zelavis", "/", { class: "brand" }), node("div", { class: "sidebar-label" }, "THE APP PLATFORM"), swiper, utilities.view, utilities.footer);
  const menus = createMenuStore();
  let auth = false;
  let projectList: readonly Project[] = [];
  let trail: Panel[] = [];
  let synchronizing = false;
  let initialized = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let snapshot: { path: string; projectId?: string; project?: Project; runtime?: Config; menu?: unknown } = { path: "/" };
  const slides: HTMLElement[] = [];
  const navigate = (path: string, ids: readonly string[], view: "menu" | "content") => {
    const url = new URL(mounted(path), location.href);
    url.searchParams.set("sidebar", ids.join("/"));
    if (media.matches) url.searchParams.set("sidebarView", view);
    void router.navigate(url.href).catch(console.error);
  };
  function showMenu() {
    const url = new URL(router.url()); url.searchParams.set("sidebarView", "menu");
    url.searchParams.delete("sidebarUtility"); url.searchParams.delete("sidebarUtilityPanel");
    void router.navigate(url.href, { focus: "preserve", scroll: "preserve" }).catch(console.error);
  }
  function sync(path: string, projectId?: string, project?: Project, runtime?: Config, menu?: unknown) {
    snapshot = { path, projectId, project, runtime, menu };
    const utilityVisible = utilities.sync(projectList, projectId, options.config());
    swiper.hidden = utilityVisible;
    host.classList.toggle("utility-open", utilityVisible);
    const basePanels = panelsFor(projectId, project, runtime, menu, projectList);
    const reported = menus.get(projectId);
    const panels = reported !== undefined ? workspacePanels(basePanels, reported, projectId) : basePanels;
    const matches = router.matches();
    const handle = matches.at(-1)?.handle as DashboardHandle | undefined;
    const url = new URL(router.url());
    // While the exact Project is loading, retain its route-declared panels; capability filtering follows the response.
    let next = resolveTrail(panels, trailForLocation(panels, url).length ? trailForLocation(panels, url) : handle?.sidebarTrail ?? [], url.searchParams.get("sidebar"));
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
      revealOverflow(nav);
      panel.items.forEach(item => {
        const destination = new URL(mounted(item.path), location.href);
        const ids = trail.slice(1, index + 1).map(panel => panel.id);
        if (item.branch) ids.push(item.branch);
        destination.searchParams.set("sidebar", ids.join("/"));
        if (media.matches) destination.searchParams.set("sidebarView", item.branch ? "menu" : "content");
        const itemPath = unmounted(destination.pathname);
        const selected = ["databaseTenant", "databaseTable", "databaseSystemView"];
        const dialog = destination.searchParams.get("databaseDialog");
        // An item that opens a dialog is active only while that dialog is; every other item ignores the dialog.
        const matchesSearch = selected.every(key => destination.searchParams.get(key) === url.searchParams.get(key)) && (dialog === null || dialog === url.searchParams.get("databaseDialog"));
        // Opening a dialog from the page it belongs to keeps what is on that page (the open table, filter, sort).
        const href = new URL(destination);
        if (dialog !== null && path === itemPath) { const kept = new URL(url); for (const key of ["sidebar", "sidebarView"]) { const value = destination.searchParams.get(key); if (value === null) kept.searchParams.delete(key); else kept.searchParams.set(key, value); } kept.searchParams.set("databaseDialog", dialog); href.search = kept.search; }
        const active = itemIsActive({ current: path, itemPath, matchesSearch, ...(item.branch ? { branch: item.branch } : {}), trail: trail.map(panel => panel.id) });
        const anchor = node("a", { href: `${href.pathname}${href.search}`, title: item.label, ...(active ? { class: "active", "aria-current": "page" } : {}) }, node("span", { class: "nav-label" }, node("span", { class: "nav-text" }, item.label)), item.branch ? node("span", { "aria-hidden": "true", class: "chevron" }, "›") : undefined);
        nav.append(anchor);
      });
      slide.replaceChildren(index ? backRow(panel.label, trail[index - 1].label, () => navigate(trail[index - 1].path, trail.slice(1, index).map(panel => panel.id), "menu")) : node("div", { class: "panel-heading" }, node("strong", {}, "Platform")), nav);
    });
    const trim = () => { while (slides.length > trail.length) slides.pop()!.remove(); swiper.swiper?.update(); };
    // Outgoing panels stay present until Back has animated to its parent.
    if (previousDepth > trail.length && initialized) timer = setTimeout(() => { synchronizing = true; trim(); if (media.matches && new URL(router.url()).searchParams.get("sidebarView") !== "menu") swiper.swiper.slideTo(trail.length, 0); synchronizing = false; }, reduced.matches ? 0 : 310); else trim();
    if (media.matches) { if (mobileSlide.parentNode !== swiper) swiper.append(mobileSlide); if (content.parentNode !== mobileSlide) mobileSlide.append(content); } else { mobileSlide.remove(); if (content.parentNode !== main) main.append(content); }
    if (!initialized) {
      // Mouse/trackpad clicks can drift between press and release. Swiper's
      // simulated drag otherwise cancels them even with allowTouchMove=false.
      // Real touch gestures still control the mobile panels.
      Object.assign(swiper, { slidesPerView: 1, speed: reduced.matches ? 0 : 300, simulateTouch: false, allowTouchMove: media.matches, injectStyles: [":host{height:100%;min-height:0}.swiper{height:100%}.swiper-wrapper{height:100%}"] });
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
  return { sync, showMenu, setWorkspaceNavigation(items: unknown, projectId?: string) { menus.set(projectId, items); resized(); }, closeUtility: utilities.close, setProjects(list: readonly Project[]) { projectList = list; resized(); }, setAuth(value: boolean) { auth = value; if (auth && content.parentNode !== main) main.append(content); }, dispose() { utilities.dispose(); if (timer) clearTimeout(timer); media.removeEventListener("change", resized); reduced.removeEventListener("change", resized); swiper.removeEventListener("swiperslidechange", changed); swiper.swiper?.destroy(true, true); } };
}
