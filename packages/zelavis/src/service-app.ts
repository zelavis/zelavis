/**
 * Synthesize asset-serving routes from a service's `app` field.
 *
 * Services that declare an `app` are turned into a separate
 * `ZelavisRuntimeService` whose routes serve static bundle bytes via a
 * `BundleStore`. This keeps the request dispatcher itself unchanged:
 * everything still flows through the same route table; "static file" is
 * just a handler that happens to read from a bundle store and apply
 * SPA-fallback or MPA-filesystem semantics.
 *
 * Why a separate synthesized service and not in-place mutation of the
 * service's own service entry: service definitions are frozen, app-routes
 * are distinct in lifecycle (purely host-side, no service-state), and we
 * want them to appear as their own debuggable mount in the routes table.
 */

import type { BundleScope, BundleStore } from "./bundle-store.js";
import {
  listAuthorizedHostsForService,
  type DomainBindingStore,
} from "./domain-binding.js";
import type {
  ZelavisServiceAppDefinition,
  ZelavisServiceAppShellDefinition,
  ZelavisServiceDefinition,
} from "./service.js";
import type {
  ZelavisRouteResponse,
  ZelavisServerRoute,
  ZelavisRuntimeService,
} from "./core/index.js";

const DEFAULT_BUNDLE = "dist";
const DEFAULT_INDEX_HTML = "index.html";
const DEFAULT_MOUNT = "/";

function servicePathSegment(serviceName: string): string {
  return encodeURIComponent(serviceName);
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
};

function guessContentType(path: string): string {
  const lastDot = path.lastIndexOf(".");
  if (lastDot < 0) {
    return "application/octet-stream";
  }
  const ext = path.slice(lastDot).toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * Strip the mount prefix from the requested pathname to produce the
 * bundle-relative path. Returns the empty string for the mount root, so
 * callers know to serve `indexHtml`.
 */
function stripMount(mount: string, pathname: string): string | undefined {
  if (mount === "/" || mount === "") {
    return pathname.replace(/^\/+/, "");
  }
  if (pathname === mount) {
    return "";
  }
  const withSlash = mount.endsWith("/") ? mount : `${mount}/`;
  if (!pathname.startsWith(withSlash)) {
    return undefined;
  }
  return pathname.slice(withSlash.length);
}

interface AppHandlerOptions {
  bundleStore: BundleStore;
  scope: BundleScope;
  mount: string;
  indexHtml: string;
  mode: "spa" | "mpa";
  /**
   * When set, the synthesized handler calls `shell.render` for index
   * requests and SPA-fallback misses instead of reading `indexHtml` from
   * the bundle. Apps can use this to inject runtime config into their
   * HTML shell.
   */
  shell?: ZelavisServiceAppShellDefinition;
  /**
   * When set, the synthesized handler short-circuits every request
   * under the mount with a 307 redirect to `devUrl + relativePath +
   * querystring`. Used during local development so edits to the SPA's
   * own dev server (Vite/RR/Next) show up without rebuilding the
   * embedded bundle on every save.
   *
   * Redirect (not server-side proxy) is the right primitive: the browser
   * connects directly to the dev server, so its HMR socket, source-map
   * mapping, and dev-only headers all work as the framework expects.
   */
  devUrl?: string;
  /**
   * Mount-relative prefixes that should not redirect to `devUrl`. These paths
   * fall through to normal runtime handling so reserved API namespaces stay
   * reachable while a dashboard or app shell is served from a dev server.
   */
  devUrlExcludePaths?: readonly string[];
  /**
   * Optional override resolved when the route handler executes; lets
   * higher-level code (tenant context, dev-mode toggle) influence the
   * scope at request time without re-synthesizing routes.
   */
  resolveScope?: (request: Request) => BundleScope | undefined;
}

/**
 * Build a 307 redirect from a mount-relative path + querystring to a
 * configured dev-server URL.
 *
 * The dev URL may itself contain a path (e.g.
 * `http://localhost:3001/zelavis`). We append the relative path with a
 * single slash separator and preserve the querystring verbatim.
 *
 * For the mount root (`relativePath === ""`), we still produce a
 * trailing slash on the target so the dev server's own routing sees
 * the directory form. Some dev servers (Vite history fallback) depend
 * on this.
 */
function buildDevRedirect(
  devUrl: string,
  relativePath: string,
  search: string,
) {
  const normalizedDevUrl = devUrl.replace(/\/+$/, "");
  const normalizedPath = relativePath.replace(/^\/+/, "");
  const targetPath = normalizedPath ? `/${normalizedPath}` : "/";
  return {
    status: 307 as const,
    headers: {
      location: `${normalizedDevUrl}${targetPath}${search}`,
      "cache-control": "no-cache",
    },
  };
}

function normalizeDevExcludePath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

function isDevRedirectExcluded(
  relativePath: string,
  excludePaths: readonly string[] | undefined,
): boolean {
  if (!excludePaths || excludePaths.length === 0) {
    return false;
  }

  const normalizedPath = normalizeDevExcludePath(relativePath);
  return excludePaths.some((path) => {
    const normalizedExclude = normalizeDevExcludePath(path);
    return (
      normalizedExclude.length > 0 &&
      (normalizedPath === normalizedExclude ||
        normalizedPath.startsWith(`${normalizedExclude}/`))
    );
  });
}

/**
 * Default content-type / cache-control applied when shell.render returns
 * a `string` body without explicit headers. Renderers that need to send
 * different headers (e.g. an error page, a redirect) can supply their
 * own `headers` and the synthesizer respects them verbatim.
 */
const DEFAULT_SHELL_CONTENT_TYPE = "text/html; charset=utf-8";
const DEFAULT_SHELL_CACHE_CONTROL = "no-cache";

async function renderShell(
  shell: ZelavisServiceAppShellDefinition,
  request: Request,
  relativePath: string,
): Promise<ZelavisRouteResponse> {
  const result = await shell.render({ request, path: relativePath });
  const status = result.status ?? 200;
  const headers =
    result.headers ??
    ({
      "content-type": DEFAULT_SHELL_CONTENT_TYPE,
      "cache-control": DEFAULT_SHELL_CACHE_CONTROL,
    } as Record<string, string>);
  return { status, headers, body: result.body };
}

function buildResponse(
  body: Uint8Array,
  contentType: string,
  cacheControl?: string,
  status = 200,
): ZelavisRouteResponse {
  const headers: Record<string, string> = { "content-type": contentType };
  if (cacheControl) {
    headers["cache-control"] = cacheControl;
  }
  return { status, headers, body };
}

async function readWithFallback(
  store: BundleStore,
  scope: BundleScope,
  candidates: readonly string[],
) {
  for (const candidate of candidates) {
    const asset = await store.read(scope, candidate);
    if (asset) {
      return { asset, resolvedPath: candidate };
    }
  }
  return undefined;
}

function createAppAssetHandler(options: AppHandlerOptions) {
  const {
    bundleStore,
    scope: defaultScope,
    mount,
    indexHtml,
    mode,
    shell,
    devUrl,
    devUrlExcludePaths,
  } = options;

  return async (context: {
    request: Request;
    params: Record<string, string>;
  }) => {
    const { request, params } = context;
    const scope = options.resolveScope?.(request) ?? defaultScope;
    // Resolve the mount-relative path. Three cases:
    //
    //  - `*path` route via the dispatcher → `params.path` is set and
    //    already mount-relative, regardless of any higher-level
    //    dispatcher prefix.
    //  - index route via the dispatcher → no `*path` param, but the
    //    handler is mounted at the index by construction. The request
    //    is the mount root; relativePath is "".
    //  - direct handler invocation outside the dispatcher (e.g. in
    //    tests, or unit-level handler calls) → no params at all. Fall
    //    back to URL-based mount stripping, which only knows about the
    //    synthesized mount and may produce a wrong answer if the host
    //    stacked extra prefixes on top.
    const relativePath =
      typeof params?.path === "string"
        ? params.path
        : params !== undefined && Object.keys(params).length === 0
          ? ""
          : (stripMount(mount, new URL(request.url).pathname) ?? "");
    if (relativePath === undefined) {
      // Defensive: this handler is only mounted under the mount prefix, so
      // a non-match here would be a routing bug. Surface a 404 rather than
      // serving the app shell from an unrelated URL.
      return { status: 404, body: "Not found" };
    }

    // Dev-server short-circuit: when `devUrl` is set, every request
    // under the mount becomes a 307 redirect to the dev server. Bundle
    // store, shell renderer, and MPA resolution all sit out — the
    // browser talks to Vite/RR/Next directly so HMR works.
    if (devUrl && !isDevRedirectExcluded(relativePath, devUrlExcludePaths)) {
      const url = new URL(request.url);
      return buildDevRedirect(devUrl, relativePath, url.search);
    }

    if (mode === "spa") {
      // Root request: shell.render takes precedence over a static
      // `indexHtml` so services can inject runtime config.
      if (relativePath === "") {
        if (shell) {
          return renderShell(shell, request, relativePath);
        }
        const indexHit = await bundleStore.read(scope, indexHtml);
        if (!indexHit) {
          return { status: 404, body: "Not found" };
        }
        return buildResponse(
          indexHit.body,
          indexHit.contentType ?? guessContentType(indexHtml),
          indexHit.cacheControl,
        );
      }

      // Sub-path: try the exact asset, then SPA-fallback to either the
      // shell renderer or the static index document.
      const exactHit = await bundleStore.read(scope, relativePath);
      if (exactHit) {
        return buildResponse(
          exactHit.body,
          exactHit.contentType ?? guessContentType(relativePath),
          exactHit.cacheControl,
        );
      }
      if (shell) {
        return renderShell(shell, request, relativePath);
      }
      const fallbackHit = await bundleStore.read(scope, indexHtml);
      if (!fallbackHit) {
        return { status: 404, body: "Not found" };
      }
      return buildResponse(
        fallbackHit.body,
        fallbackHit.contentType ?? guessContentType(indexHtml),
        fallbackHit.cacheControl,
      );
    }

    // MPA mode: filesystem-style resolution. Try the exact path, then
    // `<path>.html`, then `<path>/index.html`. No SPA fallback, but if a
    // shell renderer is configured it gets a chance to handle the root.
    if (relativePath === "" && shell) {
      return renderShell(shell, request, relativePath);
    }
    const candidates: string[] = [];
    if (relativePath === "") {
      candidates.push(indexHtml);
    } else {
      candidates.push(relativePath);
      if (!relativePath.endsWith(".html")) {
        candidates.push(`${relativePath}.html`);
        candidates.push(
          `${relativePath.replace(/\/+$/, "")}/${indexHtml}`,
        );
      }
    }
    const hit = await readWithFallback(bundleStore, scope, candidates);
    if (!hit) {
      return { status: 404, body: "Not found" };
    }
    const contentType =
      hit.asset.contentType ?? guessContentType(hit.resolvedPath);
    return buildResponse(hit.asset.body, contentType, hit.asset.cacheControl);
  };
}

export interface SynthesizeServiceAppOptions {
  /**
   * The service whose `app` field should be turned into a service. If the
   * service has no `app`, returns `undefined`.
   */
  service: Readonly<ZelavisServiceDefinition<unknown>>;
  /** Bundle store the synthesized handlers will read from. */
  bundleStore: BundleStore;
  /**
   * Project this service belongs to. Optional — undefined is treated as
   * system scope by the default `SharedBundleStore`.
   */
  projectId?: string;
  /**
   * Override the effective mount path after scope-based rewriting. The
   * caller (`activateServiceRegistry`) supplies this for extension-scoped
   * services, which are forced under `/apps/<service-name>` regardless of
   * what their definition claims.
   */
  effectiveMount?: string;
  /**
   * Domain bindings store. When set, extension-scoped service apps can be
   * host-bound to verified bindings owned by their project or by the
   * service itself. Concrete hostnames are runtime activation state, not
   * service metadata.
   */
  domainBindings?: DomainBindingStore;
}

/**
 * Produce a `ZelavisRuntimeService` that serves the service's app bundle, or
 * `undefined` if the service doesn't declare an `app`.
 *
 * Async because the domain-binding store lookups it does for
 * extension services may be I/O-bound (KV / blob backends).
 */
export async function synthesizeServiceAppService(
  options: SynthesizeServiceAppOptions,
): Promise<ZelavisRuntimeService | undefined> {
  const { service, bundleStore, projectId, effectiveMount, domainBindings } =
    options;
  const app = service.app;
  if (!app) {
    return undefined;
  }

  const bundle = app.bundle ?? DEFAULT_BUNDLE;
  const indexHtml = app.indexHtml ?? DEFAULT_INDEX_HTML;
  const mode = app.mode ?? "spa";
  const domainPolicy = app.domainPolicy ?? "optional";

  // Gate extension services behind verified runtime domain bindings.
  // System services are trusted host-side code, so their synthesized
  // routes stay host-agnostic unless the host provides a narrower mount
  // through a future deployment adapter.
  let hosts: readonly string[] | undefined;
  if (service.scope === "extension") {
    const authorized = await listAuthorizedHostsForService({
      scope: "extension",
      projectId,
      serviceName: service.name,
      domainBindings,
    });
    hosts = authorized.length > 0 ? Object.freeze([...authorized]) : undefined;

    if ((!hosts || hosts.length === 0) && domainPolicy === "required") {
      return undefined;
    }
  }

  // Mount selection:
  //  - System services keep whatever mount they declared.
  //  - Extension services with verified host bindings serve their
  //    declared mount (typically "/") restricted to those hosts. The
  //    host itself provides namespace isolation, so no path-prefix
  //    rewrite is needed.
  //  - Extension services without verified hosts get the
  //    `/apps/<service-name>` namespaced mount on the shared host,
  //    where path-prefixing is the only thing preventing collisions.
  //
  // Callers may override via `effectiveMount` — primarily for tests
  // or for system services whose effective mount is chosen by the host.
  let mount: string;
  if (effectiveMount !== undefined) {
    mount = effectiveMount;
  } else if (service.scope === "extension" && (!hosts || hosts.length === 0)) {
    mount = `/apps/${servicePathSegment(service.name)}`;
  } else {
    mount = app.mount ?? DEFAULT_MOUNT;
  }

  const scope: BundleScope = {
    projectId,
    serviceName: service.name,
    bundle,
  };

  const handler = createAppAssetHandler({
    bundleStore,
    scope,
    mount,
    indexHtml,
    mode,
    shell: app.shell,
    devUrl: app.devUrl,
    devUrlExcludePaths: app.devUrlExcludePaths,
  });

  const routes: ZelavisServerRoute<unknown>[] = [
    {
      id: `${service.name}.app.index`,
      method: "GET",
      path: "/",
      host: hosts,
      handler,
    },
    {
      id: `${service.name}.app.assets`,
      method: "GET",
      path: "/*path",
      host: hosts,
      handler,
    },
  ];

  return Object.freeze({
    name: `${service.name}:app`,
    basePath: mount,
    service: Object.freeze({}),
    api: Object.freeze({
      v1: Object.freeze(routes),
    }),
  }) as ZelavisRuntimeService;
}

/**
 * Apply scope-based mount rewriting. Extension-scoped services (uploaded
 * ZIPs, marketplace installs) are corralled under `/apps/<service-name>`
 * regardless of what mount they declare, so a tenant can't squat a
 * reserved prefix like `/zelavis` or `/api`. System-scope services keep
 * whatever mount they declared.
 */
export function resolveEffectiveMount(
  service: Readonly<ZelavisServiceDefinition<unknown>>,
): string {
  const declared = service.app?.mount ?? DEFAULT_MOUNT;
  if (service.scope === "system") {
    return declared;
  }
  // Extension scope: always namespaced.
  return `/apps/${servicePathSegment(service.name)}`;
}
