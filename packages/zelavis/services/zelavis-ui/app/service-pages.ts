import { Effect, Fiber } from "effect";
import { ApiError, array, label, object, request, type Config } from "./api.ts";
import { message, node } from "./dom.ts";
import { API_PREFIX } from "./mount.ts";

export type ServicePage = { path: string; title: string; src?: string; hasPage: boolean; serviceName: string; trusted: boolean; apiPath?: string; search: Record<string, string> };
const slug = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const pathOnly = (value: unknown): value is string => typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !/[\\?#\u0000-\u0020]/.test(value) && !/%(?:2e|5c|25)/i.test(value) && !value.split("/").some(part => part === "." || part === "..");

/** Runtime paths are authoritative; Project pages and grants must use its exact proxy. */
export function scopedRuntimePath(config: Config, path: unknown): string | undefined {
  if (!pathOnly(path)) return undefined;
  const marker = "/proxy/";
  const index = config.api.basePath.indexOf(marker);
  const prefix = index < 0 ? "" : config.api.basePath.slice(0, index + marker.length - 1);
  const localApi = index < 0 ? config.api.basePath : config.api.basePath.slice(index + marker.length - 1);
  if (path !== localApi && !path.startsWith(`${localApi}/`)) return undefined;
  return `${prefix}${path}`;
}

export function servicePages(config: Config, registry: unknown = config.serviceRegistry, projectId?: string): ServicePage[] {
  const pages: ServicePage[] = [];
  const seen = new Set<string>();
  const services = [...array(config.services), ...array(registry)].map(object);
  let visited = 0;
  for (const service of services) {
    if (typeof service.name !== "string" || seen.has(service.name) || service.status && service.status !== "installed") continue;
    seen.add(service.name);
    const serviceName = service.name;
    const trusted = service.scope === "system";
    const segment = slug(service.name.replace(/^@/, "").replace(/^zelavis\//, ""));
    const menus = Array.isArray(service.menus) ? service.menus : service.menu ? [service.menu] : [];
    const walk = (values: unknown[], parents: string[], depth: number, surface?: unknown) => {
      if (depth > 16) throw new Error("Service menus exceeded the nesting limit.");
      for (const raw of values) {
        if (++visited > 512) throw new Error("Service menus exceeded the dashboard limit.");
        const menu = object(raw); const title = label(menu.title, "Service page");
        const menuSurface = menu.surface ?? surface ?? object(service.menu).surface ?? "core";
        if (menu.disabled === true || projectId && menuSurface === "platform" || !projectId && trusted && menuSurface !== "platform") continue;
        const current = slug(title);
        const segments = [segment && ((parents.length === 0 && segment === current) || parents[0] === segment) ? undefined : segment, ...parents, parents.at(-1) === current ? undefined : current].filter(Boolean);
        const path = menu.path ?? `/${segments.join("/")}`;
        if (!pathOnly(path)) continue;
        const page = object(menu.page);
        const src = scopedRuntimePath(config, page.src);
        const assetPrefix = `${config.api.basePath}/runtime/service-page-assets/${encodeURIComponent(serviceName)}/`;
        const search: Record<string, string> = {};
        for (const [key, value] of Object.entries(object(menu.search))) if (typeof value === "string") search[key] = value;
        pages.push({ path: `${projectId ? `/projects/${encodeURIComponent(projectId)}` : ""}${path === "/" && projectId ? "" : path}`, title: label(page.title, label(menu.pageLabel, title)), hasPage: menu.page !== undefined, serviceName, trusted, apiPath: scopedRuntimePath(config, service.apiPath), ...(src?.startsWith(assetPrefix) ? { src } : {}), search });
        walk(array(menu.items), [...parents, current], depth + 1, menuSurface);
      }
    };
    walk(menus, [], 0);
  }
  return pages;
}

export type BrokerGrant = { serviceName: string; apiPath: string };
export function resolveBrokeredPath(path: unknown, grant: BrokerGrant): string | undefined {
  if (typeof path !== "string" || !path || path.length > 4096 || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//") || /[\\#\u0000-\u0020]/.test(path) || /%(?:2e|2f|5c|25)/i.test(path) || path.split(/[/?]/).some(part => part === "." || part === "..")) return undefined;
  if (!pathOnly(grant.apiPath) || !grant.apiPath.startsWith(API_PREFIX)) return undefined;
  const base = grant.apiPath.replace(/\/+$/, "");
  const result = new URL(path.replace(/^\/+/, ""), `http://service.invalid${base}/`);
  return result.pathname.startsWith(`${base}/`) ? result.pathname + result.search : undefined;
}

/** Scoped listener, bounded requests and no credentials or redirects passed to the frame. */
export const installServiceBroker = Effect.fn("new-ui.installServiceBroker")(function*(frame: HTMLIFrameElement, grant: BrokerGrant) {
  const owner = frame.ownerDocument.defaultView!;
  const requests = new Map<string, Fiber.Fiber<void, never>>();
  const reply = (source: Window, id: string, payload: Record<string, unknown>) => {
    if (frame.isConnected && frame.contentWindow === source) source.postMessage({ zelavis: "service-page-response", id, ...payload }, "*");
  };
  let initialLoad = true;
  const interrupt = () => { for (const fiber of requests.values()) Effect.runFork(Fiber.interrupt(fiber)); requests.clear(); };
  const onLoad = () => {
    if (initialLoad) { initialLoad = false; return; }
    // A different document must not inherit the old page's grant through WindowProxy.
    owner.removeEventListener("message", onMessage); interrupt();
    frame.insertAdjacentElement("beforebegin", message("This service page navigated. Refresh the dashboard to reopen its scoped API access."));
  };
  const onMessage = (event: MessageEvent) => {
    if (!frame.isConnected || event.source !== frame.contentWindow) return;
    const data = object(event.data);
    if (data.zelavis !== "service-page-request" || typeof data.id !== "string" || !data.id || data.id.length > 128) return;
    const source = event.source as Window, id = data.id;
    if (requests.has(id)) return;
    const path = resolveBrokeredPath(data.path, grant);
    const method = data.method === undefined ? "GET" : typeof data.method === "string" ? data.method.toUpperCase() : "";
    if (!path || !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) { reply(source, id, { error: `${grant.serviceName} may only call its own API using supported methods.` }); return; }
    if (requests.size >= 8) { reply(source, id, { error: "Too many pending service requests." }); return; }
    const work = Effect.gen(function*() {
      const body = data.body === undefined ? undefined : yield* Effect.try({ try: () => JSON.stringify(data.body), catch: () => new ApiError({ message: "Invalid service request body." }) });
      if (body && new TextEncoder().encode(body).byteLength > 1024 * 1024) return yield* Effect.fail(new ApiError({ message: "Service request body exceeded 1 MB." }));
      if (method === "GET" && body !== undefined) return yield* Effect.fail(new ApiError({ message: "GET requests cannot contain a body." }));
      const response = yield* Effect.tryPromise({ try: signal => fetch(path, { signal, method, body, redirect: "error", credentials: "same-origin", headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) } }), catch: () => new ApiError({ message: "Service request failed." }) });
      const value = yield* readBrokerBody(response);
      reply(source, id, { status: response.status, ok: response.ok, body: value });
    }).pipe(Effect.timeout("30 seconds"), Effect.catchCause(cause => Effect.sync(() => { reply(source, id, { error: "Service request failed or timed out." }); console.warn("Service page request failed", cause); })), Effect.ensuring(Effect.sync(() => requests.delete(id))));
    const fiber = Effect.runFork(work);
    if (!fiber.pollUnsafe()) requests.set(id, fiber);
  };
  yield* Effect.acquireRelease(Effect.sync(() => { owner.addEventListener("message", onMessage); frame.addEventListener("load", onLoad); }), () => Effect.gen(function*() {
    owner.removeEventListener("message", onMessage); frame.removeEventListener("load", onLoad);
    const fibers = [...requests.values()]; requests.clear();
    yield* Effect.forEach(fibers, fiber => Fiber.interrupt(fiber), { concurrency: 8, discard: true });
  }));
});

const readBrokerBody = Effect.fn("new-ui.readBrokerBody")(function*(response: Response) {
  if (!response.body) return null;
  return yield* Effect.acquireUseRelease(Effect.sync(() => response.body!.getReader()), reader => Effect.gen(function*() {
    const decoder = new TextDecoder(); let text = "", bytes = 0;
    while (true) {
      const chunk = yield* Effect.tryPromise({ try: () => reader.read(), catch: () => new ApiError({ message: "Could not read service response." }) });
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1024 * 1024) return yield* Effect.fail(new ApiError({ message: "Service response exceeded 1 MB." }));
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text ? yield* Effect.try({ try: () => JSON.parse(text) as unknown, catch: () => new ApiError({ message: "Service response must be JSON." }) }) : null;
  }), reader => Effect.tryPromise({ try: () => reader.cancel(), catch: cause => cause }).pipe(Effect.timeout("1 second"), Effect.catchCause(cause => Effect.logWarning("Service response cleanup failed", cause))));
});

/** The capability URL of a page, or the page's own URL where this installation cannot mint one. */
const sandboxedPageSrc = Effect.fn("new-ui.sandboxedPageSrc")(function*(src: string, projectId?: string) {
  const match = /\/runtime\/service-page-assets\/([^/]+)\/([^/]+)\/(.+)$/.exec(src.split(/[?#]/)[0]!);
  if (!match) return src;
  const [, service, bundle, file] = match;
  const query = new URLSearchParams({ service: decodeURIComponent(service!), bundle: decodeURIComponent(bundle!), file: decodeURIComponent(file!), ...(projectId ? { projectId } : {}) });
  const minted = yield* request(`${API_PREFIX}v1/runtime/service-page-capability?${query}`).pipe(Effect.catch(() => Effect.succeed(undefined)));
  const capability = object(minted).src;
  return typeof capability === "string" && capability.startsWith(API_PREFIX) ? capability : src;
});

export const servicePageScreen = Effect.fn("new-ui.servicePageScreen")(function*(config: Config, path: string, projectId?: string) {
  const registry = Array.isArray(config.serviceRegistry) ? config.serviceRegistry : object(yield* request(`${config.api.basePath}/runtime/services`)).services;
  const pages = yield* Effect.try({ try: () => servicePages(config, registry, projectId), catch: cause => new ApiError({ message: String(cause) }) });
  const page = pages.find(page => page.path === path);
  if (!page || !page.hasPage) return undefined;
  if (!page.src) return node("section", { class: "panel" }, node("h2", {}, page.title), message("This service has no valid dashboard page at this address."));
  // A sandboxed page has an opaque origin, so what it loads sends no session. Its frame is given a URL that carries a signed,
  // expiring capability to read that bundle (`platform/page-capability.ts`), so its scripts and styles load as well as its HTML.
  const src = page.trusted ? page.src : yield* sandboxedPageSrc(page.src, projectId);
  const frame = node("iframe", { src, title: page.title, class: "service-frame", sandbox: page.trusted ? "allow-scripts allow-same-origin allow-forms allow-popups" : "allow-scripts allow-forms", referrerpolicy: "no-referrer" });
  if (!page.trusted && page.apiPath) yield* installServiceBroker(frame, { serviceName: page.serviceName, apiPath: page.apiPath });
  return node("section", { class: "panel service-page" }, frame);
});
