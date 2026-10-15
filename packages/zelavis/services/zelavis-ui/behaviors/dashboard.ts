import { dashboardSection } from "../app/routes.ts";
import { clearDraftJournals } from "../app/grids/drafts.ts";
import { Effect, Fiber } from "effect";
import { getRouter, mountIslands } from "fuzor/runtime";
import { registerButton } from "fuzor/ui";
import { ApiError, bootstrap, loadConfig, object, request, type Config, type Project } from "../app/api.ts";
import { button, link, message, node } from "../app/dom.ts";
import { createSidebar } from "../app/sidebar.ts";
import { loadScreen, type ScreenContext } from "../app/screens.ts";
import { mounted, ROOT, unmounted } from "../app/mount.ts";
import { startUpdateWatch } from "../app/update-watch.ts";
import { mountUpdateBanner } from "../app/update-views.ts";
import { loadPlatformMenu, loadProjectMenu } from "../app/navigation-menu.ts";

export function mount(host: HTMLElement) {
  registerButton();
  const router = getRouter(host.ownerDocument);
  if (!router) throw new Error("The dashboard needs Fuzor’s SPA router.");
  const themeMedia = matchMedia("(prefers-color-scheme: dark)");
  const applyTheme = () => {
    // Storage can be blocked (a private window, site data cleared): "auto" then follows the system preference.
    const mode = Effect.runSync(Effect.try({ try: () => localStorage.getItem("theme") ?? "auto", catch: cause => cause }).pipe(Effect.orElseSucceed(() => "auto")));
    host.ownerDocument.documentElement.dataset.dashboardTheme = mode === "auto" ? themeMedia.matches ? "dark" : "light" : mode;
  };
  applyTheme(); themeMedia.addEventListener("change", applyTheme); window.addEventListener("storage", applyTheme);
  const fibers = new Set<Fiber.Fiber<unknown, never>>();
  let pageFiber: Fiber.Fiber<unknown, never> | undefined;
  let disposed = false;
  let config: Config | undefined;
  let mutating = false;
  let generation = 0;
  const projectCache = new Map<string, { project: Project; runtime?: Config; menu?: unknown }>();
  const content = node("div", { class: "content", id: "workspace", tabindex: "-1" });
  const legacyContent = node("div");
  const outlet = host.ownerDocument.querySelector<HTMLElement>("fuzor-router")!;
  const errors = node("div", { class: "errors", "aria-live": "polite" });
  const updateBanner = node("div", { class: "update-slot" });
  const unmountUpdateBanner = mountUpdateBanner(updateBanner);
  let stopUpdates: (() => void) | undefined;
  const sidebar = node("aside", { class: "sidebar", id: "dashboard-navigation", "aria-label": "Dashboard navigation" });
  const title = node("span", { class: "breadcrumb" }, "Projects");
  const toggleButton = button("☰", () => {
    sidebarController.showMenu();
  }, { "aria-label": "Open navigation", "aria-controls": "dashboard-navigation", class: "mobile-menu" });
  const header = node("header", { class: "header" }, toggleButton, title, node("span", { class: "experiment" }, "Fuzor preview"), button("Sign out", signOut));
  function signOut() {
    if (!config) return;
    run(request(`${config.api.basePath}/auth/session`, "DELETE").pipe(Effect.tap(() => clearDraftJournals(() => host.ownerDocument.defaultView!.sessionStorage).pipe(Effect.catch(cause => Effect.logWarning("Could not clear tab draft journals on sign out", cause))))), () => navigate("/login"));
  }
  const refresh = document.createElement("fuzor-button"); refresh.setAttribute("type", "button"); refresh.textContent = "Refresh"; refresh.addEventListener("click", () => refreshPage()); header.append(refresh);
  host.classList.add("dashboard");
  host.replaceChildren(node("a", { href: "#workspace", class: "skip" }, "Skip to workspace"), sidebar, node("div", { class: "main" }, header, updateBanner, errors, content));

  content.append(outlet, legacyContent);
  const main = host.querySelector<HTMLElement>(".main")!;
  const sidebarController = createSidebar(host, sidebar, content, main, router, { onSignOut: signOut, config: () => config });

  /** The sidebar's menus come from what the Platform reports; they load beside the page and replace the basic ones. */
  function loadMenu(projectId: string | undefined, project?: Project, runtime?: Config) {
    const control = config;
    if (!control) return;
    const work = projectId
      ? project && runtime ? loadProjectMenu(control, project, runtime) : undefined
      : loadPlatformMenu(control);
    if (!work) return;
    const requested = new URL(router!.url()).pathname;
    fork(work.pipe(Effect.tap(items => Effect.sync(() => {
      if (disposed || new URL(router!.url()).pathname !== requested) return;
      sidebarController.setWorkspaceNavigation(items, projectId);
      syncNavigation();
    })), Effect.catch(error => Effect.logWarning("The navigation menu could not be loaded", error))));
  }

  function fork(work: Effect.Effect<unknown, never>) {
    const fiber = Effect.runFork(work);
    fibers.add(fiber);
    fiber.addObserver(() => fibers.delete(fiber));
    return fiber;
  }
  function navigate(path: string) {
    // URL changes remain owned by Fuzor, including query updates and Back/Forward.
    const outcome = router!.navigate(mounted(path));
    void outcome.catch(cause => { if (!disposed) errors.replaceChildren(message(String(cause), true)); });
  }
  function run<A>(work: Effect.Effect<A, ApiError>, success?: (value: A) => void) {
    if (mutating) return;
    mutating = true;
    host.setAttribute("aria-busy", "true");
    const controls = Array.from(legacyContent.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    controls.forEach(control => { control.disabled = true; });
    errors.replaceChildren();
    fork(work.pipe(Effect.ensuring(Effect.sync(() => { mutating = false; host.removeAttribute("aria-busy"); controls.forEach(control => { control.disabled = false; }); })), Effect.tap(value => Effect.sync(() => { if (!disposed) { if (success) success(value); else refreshPage(); } })), Effect.catch(error => Effect.sync(() => {
      if (disposed) return;
      // Even a failed mutation may have persisted lifecycle state or a deletion tombstone.
      refreshPage();
      errors.replaceChildren(message(error.message, true));
    }))));
  }
  function navigation(path: string, projectId?: string, project?: Project, runtime?: Config, menu?: unknown) {
    if (projectId) {
      const cached = projectCache.get(projectId);
      if (project) projectCache.set(projectId, { project, runtime: runtime ?? cached?.runtime, menu: menu ?? cached?.menu });
      project = project ?? cached?.project; runtime = runtime ?? cached?.runtime; menu = menu ?? cached?.menu;
    }
    const auth = path === "/login" || path === "/setup";
    host.classList.toggle("auth-layout", auth);
    sidebarController.setAuth(auth);
    if (auth) return;
    sidebarController.sync(path, projectId, project, runtime ?? (projectId ? undefined : config), menu);
    const matched = router!.matches().at(-1)?.handle as { pageLabel?: string } | undefined;
    title.textContent = matched?.pageLabel ?? "Workspace";
  }

  const isServerView = () => /\/projects\/[^/]+\/database\/?$/.test(new URL(router!.url()).pathname) && router!.route()?.kind === "page";
  function refreshPage() {
    if (isServerView()) void router!.navigate(router!.url(), { focus: "preserve", scroll: "preserve" }).catch(cause => errors.replaceChildren(message(String(cause), true)));
    else reload();
  }
  function reload() {
    if (disposed) return;
    const version = ++generation;
    if (pageFiber) Effect.runFork(Fiber.interrupt(pageFiber));
    const url = new URL(router!.url());
    const path = unmounted(url.pathname);
    const params = router!.params();
    const projectId = params.projectId;
    const section = dashboardSection(path, params);
    const serverView = isServerView();
    outlet.classList.toggle("server-workspace", serverView);
    legacyContent.hidden = serverView;
    if (serverView) {
      if (outlet.querySelector("[data-requires-login]")) { navigate(`/login?returnTo=${encodeURIComponent(path + url.search)}`); return; }
      const raw = outlet.querySelector<HTMLElement>("[data-project-context]")?.dataset.projectContext;
      if (raw) {
        const loaded = JSON.parse(raw);
        sidebarController.setProjects(loaded.projects);
        navigation(path, projectId, loaded.project, loaded.runtime, loaded.menu);
        loadMenu(projectId, loaded.project, loaded.runtime);
      } else navigation(path, projectId);
      return;
    }
    navigation(path, projectId);
    legacyContent.replaceChildren(message("Loading…"));
    const context: ScreenContext | undefined = config ? {
      config, url, path, projectId, section, navigate, run, refresh: refreshPage,
      projectsNavigation(list) { if (version === generation) sidebarController.setProjects(list); },
      projectNavigation(project, runtime, menu) { if (version === generation) { navigation(path, projectId, project, runtime, menu); loadMenu(projectId, project, runtime); } },
      setSearch(values) { const next = new URL(router!.url()); for (const [key, value] of Object.entries(values)) { if (value === undefined) next.searchParams.delete(key); else next.searchParams.set(key, value); } navigate(`${path}${next.search}${next.hash}`); }
    } : undefined;
    if (!context) return;
    pageFiber = fork(Effect.gen(function*() {
      const status = yield* bootstrap(context.config);
      if (status.required && path !== "/setup") { navigate("/setup"); return; }
      if (!status.required && path !== "/login" && path !== "/setup") yield* request(`${context.config.api.basePath}/runtime/access`);
      const latest = yield* loadConfig;
      if (disposed || version !== generation) return;
      config = latest; context.config = latest;
      if (!projectId && path !== "/login" && path !== "/setup" && path !== "/logout") loadMenu(undefined);
      if (path !== "/login" && path !== "/setup") stopUpdates = startUpdateWatch(latest.api.basePath);
      navigation(path, projectId);
      const screen = router!.route()?.kind === "not-found"
        ? node("section", { class: "panel" }, node("h1", {}, "Page not found"), node("p", {}, "This address does not match a dashboard route."), link("Projects", "/"))
        : yield* loadScreen(context);
      if (!disposed && version === generation) {
        legacyContent.replaceChildren(screen);
        yield* Effect.acquireRelease(Effect.tryPromise({ try: signal => mountIslands(legacyContent, { "database-grid": () => import("../app/grids/controller.ts"), "terminal": () => import("../app/terminal-view.ts"), "update-card": () => import("../app/update-views.ts"), "media-gallery": () => import("../app/media-view.ts"), "code-editor": () => import("../app/code-editor.ts"), "schema-builder": () => import("../app/schema-builder.ts"), "assistant-chat": () => import("../app/assistant-chat.ts"), "rich-text": () => import("../app/rich-text-editor.ts") }, undefined, { signal }), catch: cause => new ApiError({ message: String(cause) }) }), cleanup => Effect.promise(cleanup));
        yield* Effect.never;
      }
    }).pipe(Effect.scoped, Effect.catch(error => Effect.sync(() => {
      if (disposed || version !== generation) return;
      if (error.status === 401 && path !== "/login") { navigate(`/login?returnTo=${encodeURIComponent(path + url.search)}`); return; }
      legacyContent.replaceChildren(message(error.message, true), button("Retry", reload));
    }))));
  }
  // Path data reloads after the route and params commit; query changes retain the shell.
  let renderedPath = new URL(router.url()).pathname;
  const dataIdentity = (raw: string) => { const url = new URL(raw); for (const key of ["sidebar", "sidebarView", "sidebarUtility", "sidebarUtilityPanel", "grid", "databaseRow", "gridFilter", "gridSort"]) url.searchParams.delete(key); url.hash = ""; return url.href; };
  let renderedData = dataIdentity(router.url());
  const syncNavigation = () => { const path = unmounted(new URL(router!.url()).pathname); navigation(path, router!.params().projectId); };
  const viewCommitted = () => { if (config && isServerView()) reload(); };
  const refreshRequested = (event: Event) => {
    const projectId = (event as CustomEvent<{ projectId: string }>).detail?.projectId;
    if (isServerView() && router!.params().projectId === projectId) refreshPage();
  };
  outlet.addEventListener("fuzor:view-commit", viewCommitted);
  document.addEventListener("newui:refresh", refreshRequested);
  const unsubscribeRoute = router.subscribeRoute(() => { renderedPath = new URL(router!.url()).pathname; renderedData = dataIdentity(router!.url()); if (config) reload(); });
  const unsubscribeUrl = router.subscribeUrl(url => {
    if (new URL(url).pathname !== renderedPath || !config) return;
    if (isServerView()) { syncNavigation(); return; }
    const nextData = dataIdentity(url);
    if (nextData === renderedData) syncNavigation();
    else { renderedData = nextData; reload(); }
  });
  const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && new URL(router!.url()).searchParams.has("sidebarUtility")) sidebarController.closeUtility();
    else if (event.key === "Escape" && matchMedia("(max-width: 1023px)").matches) sidebarController.showMenu(); };
  host.addEventListener("keydown", escape);
  fork(loadConfig.pipe(Effect.flatMap(value => bootstrap(value).pipe(Effect.map(status => ({ value, status })))), Effect.tap(({ value, status }) => Effect.sync(() => {
    config = value;
    if (status.required && new URL(router.url()).pathname !== `${ROOT}/setup`) navigate("/setup"); else reload();
  })), Effect.catch(error => Effect.sync(() => legacyContent.replaceChildren(message(error.message, true))))));
  return () => {
    disposed = true; themeMedia.removeEventListener("change", applyTheme); window.removeEventListener("storage", applyTheme);
    outlet.removeEventListener("fuzor:view-commit", viewCommitted); document.removeEventListener("newui:refresh", refreshRequested);
    unsubscribeRoute(); unsubscribeUrl(); sidebarController.dispose(); host.removeEventListener("keydown", escape);
    stopUpdates?.(); unmountUpdateBanner();
    for (const fiber of fibers) Effect.runFork(Fiber.interrupt(fiber));
    fibers.clear();
  };
}
