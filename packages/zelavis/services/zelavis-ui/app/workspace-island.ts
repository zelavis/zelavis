import { Effect } from "effect";
import type { FuzorRouter } from "fuzor/runtime";
import { workspaceRouteCatalog } from "../src/workspace-route-manifest.ts";
import { node } from "./dom.ts";
import { mounted, ROOT, stripMount } from "./mount.ts";

export const workspaceFlag = "workspaceIsland";
export const presentationKeys = [workspaceFlag, "sidebar", "sidebarView", "sidebarUtility", "sidebarUtilityPanel"] as const;
const relative = (url: URL) => stripMount(url.pathname) || "/";
export function workspacePath(input: URL) {
  const url = new URL(input); for (const key of presentationKeys) url.searchParams.delete(key);
  return relative(url) + url.search + url.hash;
}
export function hasWorkspaceRoute(path: string) {
  return workspaceRouteCatalog.some(route => route.path !== "/*" && route.path !== "/_api/relations/:collection" && new RegExp(`^${route.path.split("/").map(part => part.startsWith(":") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/")}/?$`).test(path));
}
export function workspaceFrame(url: URL) {
  const destination = new URL(url); destination.searchParams.set(workspaceFlag, "1");
  return node("iframe", { class: "feature-workspace", title: "Dashboard workspace", src: destination.pathname + destination.search, "data-feature-workspace": "" });
}
/** Only our same-origin workspace window can ask Fuzor to commit a navigation. */
export function installWorkspaceBridge(host: HTMLElement, router: FuzorRouter, onContext: (value: { items: unknown; projectId?: string; projects: unknown; runtime: unknown }) => void) {
  const window = host.ownerDocument.defaultView!;
  const effect = (work: () => Promise<unknown>) => Effect.runFork(Effect.tryPromise({ try: work, catch: cause => cause }).pipe(Effect.catch(cause => Effect.logWarning("Workspace navigation failed", cause))));
  const receive = (event: MessageEvent) => {
    const frame = host.querySelector<HTMLIFrameElement>("iframe[data-feature-workspace]");
    if (!frame || event.source !== frame.contentWindow || event.origin !== window.location.origin) return;
    if (event.data?.type === "newui:workspace-menu" && window.matchMedia("(max-width: 1023px)").matches) {
      const next = new URL(router.url()); next.searchParams.set("sidebarView", "menu");
      effect(() => router.navigate(next.href, { focus: "preserve", scroll: "preserve" })); return;
    }
    if (event.data?.type === "newui:workspace-context") { onContext(event.data); return; }
    if (event.data?.type !== "newui:workspace-navigation") return;
    const path = event.data.path;
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return;
    const next = new URL(mounted(path), window.location.origin);
    if (next.origin !== window.location.origin || !next.pathname.startsWith(`${ROOT}/`)) return;
    next.searchParams.delete(workspaceFlag);
    const current = new URL(router.url());
    if (next.pathname !== current.pathname) { next.searchParams.delete("sidebar"); next.searchParams.delete("sidebarUtility"); next.searchParams.delete("sidebarUtilityPanel"); }
    for (const key of ["sidebar", "sidebarView", "sidebarUtility", "sidebarUtilityPanel"]) if ((next.pathname === current.pathname || key === "sidebarView") && !next.searchParams.has(key) && current.searchParams.has(key)) next.searchParams.set(key, current.searchParams.get(key)!);
    effect(() => router.navigate(next.href, { ...(event.data.replace ? { replace: true } : {}), focus: "preserve", scroll: "preserve" }));
  };
  window.addEventListener("message", receive);
  const sync = () => {
    const frame = host.querySelector<HTMLIFrameElement>("iframe[data-feature-workspace]");
    frame?.contentWindow?.postMessage({ type: "newui:workspace-url", path: workspacePath(new URL(router.url())) }, window.location.origin);
  };
  const unsubscribe = router.subscribeUrl(sync);
  return { sync, dispose() { unsubscribe(); window.removeEventListener("message", receive); } };
}
