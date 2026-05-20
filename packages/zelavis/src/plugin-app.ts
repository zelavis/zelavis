/**
 * Synthesize asset-serving routes from a plugin's `app` field.
 *
 * Plugins that declare an `app` are turned into a separate
 * `ZelavisService` whose routes serve static bundle bytes via a
 * `BundleStore`. This keeps the request dispatcher itself unchanged:
 * everything still flows through the same route table; "static file" is
 * just a handler that happens to read from a bundle store and apply
 * SPA-fallback or MPA-filesystem semantics.
 *
 * Why a separate synthesized service and not in-place mutation of the
 * plugin's own service entry: plugin definitions are frozen, app-routes
 * are distinct in lifecycle (purely host-side, no service-state), and we
 * want them to appear as their own debuggable mount in the routes table.
 */

import type { BundleScope, BundleStore } from "./bundle-store.js";
import type {
  ZelavisPluginAppDefinition,
  ZelavisPluginAppShellDefinition,
  ZelavisPluginDefinition,
} from "./plugin.js";
import type {
  ZelavisRouteResponse,
  ZelavisServerRoute,
  ZelavisService,
} from "@zelavis/server";

const DEFAULT_BUNDLE = "dist";
const DEFAULT_INDEX_HTML = "index.html";
const DEFAULT_MOUNT = "/";

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
 * Normalize a route's host matcher to an array form, since the contract
 * accepts either string or readonly string[]. The dispatcher handles both,
 * but consumers reasoning about app routes (debug, admin UIs) get a
 * predictable shape this way.
 */
function normalizeAppHosts(
  app: ZelavisPluginAppDefinition,
): readonly string[] | undefined {
  if (!app.domains || app.domains.length === 0) {
    return undefined;
  }
  const hosts: string[] = [];
  for (const entry of app.domains) {
    hosts.push(typeof entry === "string" ? entry : entry.host);
  }
  // If the wildcard sentinel appears, the matcher is effectively
  // host-agnostic and we can omit it — the dispatcher treats `undefined`
  // and `"*"` the same way.
  if (hosts.includes("*")) {
    return undefined;
  }
  return Object.freeze(hosts);
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
   * the bundle. The dashboard uses this to inject runtime config into
   * its HTML shell.
   */
  shell?: ZelavisPluginAppShellDefinition;
  /**
   * Optional override resolved when the route handler executes; lets
   * higher-level code (workspace context, dev-mode toggle) influence the
   * scope at request time without re-synthesizing routes.
   */
  resolveScope?: (request: Request) => BundleScope | undefined;
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
  shell: ZelavisPluginAppShellDefinition,
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
  const { bundleStore, scope: defaultScope, mount, indexHtml, mode, shell } =
    options;

  return async (context: {
    request: Request;
    params: Record<string, string>;
  }) => {
    const { request, params } = context;
    const scope = options.resolveScope?.(request) ?? defaultScope;
    // Prefer the dispatcher-provided `*path` param when available, since
    // it's already mount-relative no matter how many prefixes the host
    // stacked above the synthesized service. Fall back to mount-stripping
    // for the index route (which has no wildcard param) and for callers
    // that invoke the handler directly without going through the
    // dispatcher.
    const relativePath =
      typeof params?.path === "string"
        ? params.path
        : (stripMount(mount, new URL(request.url).pathname) ?? "");
    if (relativePath === undefined) {
      // Defensive: this handler is only mounted under the mount prefix, so
      // a non-match here would be a routing bug. Surface a 404 rather than
      // serving the SPA shell from an unrelated URL.
      return { status: 404, body: "Not found" };
    }

    if (mode === "spa") {
      // Root request: shell.render takes precedence over a static
      // `indexHtml` so plugins can inject runtime config.
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

export interface SynthesizePluginAppOptions {
  /**
   * The plugin whose `app` field should be turned into a service. If the
   * plugin has no `app`, returns `undefined`.
   */
  plugin: Readonly<ZelavisPluginDefinition<unknown>>;
  /** Bundle store the synthesized handlers will read from. */
  bundleStore: BundleStore;
  /**
   * Workspace this plugin belongs to. Optional — undefined is treated as
   * system scope by the default `SharedBundleStore`.
   */
  workspaceId?: string;
  /**
   * Override the effective mount path after scope-based rewriting. The
   * caller (`activatePluginRegistry`) supplies this for workspace-scoped
   * plugins, which are forced under `/apps/<plugin-name>` regardless of
   * what their definition claims.
   */
  effectiveMount?: string;
}

/**
 * Produce a `ZelavisService` that serves the plugin's app bundle, or
 * `undefined` if the plugin doesn't declare an `app`.
 */
export function synthesizePluginAppService(
  options: SynthesizePluginAppOptions,
): ZelavisService | undefined {
  const { plugin, bundleStore, workspaceId, effectiveMount } = options;
  const app = plugin.app;
  if (!app) {
    return undefined;
  }

  const mount = effectiveMount ?? app.mount ?? DEFAULT_MOUNT;
  const bundle = app.bundle ?? DEFAULT_BUNDLE;
  const indexHtml = app.indexHtml ?? DEFAULT_INDEX_HTML;
  const mode = app.mode ?? "spa";
  const hosts = normalizeAppHosts(app);

  const scope: BundleScope = {
    workspaceId,
    pluginName: plugin.name,
    bundle,
  };

  const handler = createAppAssetHandler({
    bundleStore,
    scope,
    mount,
    indexHtml,
    mode,
    shell: app.shell,
  });

  const routes: ZelavisServerRoute<unknown>[] = [
    {
      id: `${plugin.name}.app.index`,
      method: "GET",
      path: "/",
      host: hosts,
      handler,
    },
    {
      id: `${plugin.name}.app.assets`,
      method: "GET",
      path: "/*path",
      host: hosts,
      handler,
    },
  ];

  return Object.freeze({
    name: `${plugin.name}:app`,
    basePath: mount,
    service: Object.freeze({}),
    api: Object.freeze({
      v1: Object.freeze(routes),
    }),
  }) as ZelavisService;
}

/**
 * Apply scope-based mount rewriting. Workspace-scoped plugins (uploaded
 * ZIPs, marketplace installs) are corralled under `/apps/<plugin-name>`
 * regardless of what mount they declare, so a tenant can't squat a
 * reserved prefix like `/zelavis` or `/api`. System-scope plugins keep
 * whatever mount they declared.
 */
export function resolveEffectiveMount(
  plugin: Readonly<ZelavisPluginDefinition<unknown>>,
): string {
  const declared = plugin.app?.mount ?? DEFAULT_MOUNT;
  if (plugin.scope === "system") {
    return declared;
  }
  // Workspace scope: always namespaced.
  return `/apps/${plugin.name}`;
}
