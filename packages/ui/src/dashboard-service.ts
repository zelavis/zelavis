import {
  embeddedDashboardAssets,
  embeddedDashboardShell,
  type EmbeddedDashboardAsset,
} from "./generated/dashboard-assets.js";

export interface ZelavisDashboardServiceRoute {
  id: string;
  method: string;
  path: string;
  handler: unknown;
}

export interface ZelavisDashboardBundleAsset {
  path: string;
  body: Uint8Array;
  size?: number;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
}

export interface ZelavisDashboardBundleStore {
  read: (
    scope: { projectId?: string; serviceName: string; bundle: string },
    path: string,
  ) =>
    | Promise<ZelavisDashboardBundleAsset | undefined>
    | ZelavisDashboardBundleAsset
    | undefined;
}

export interface ZelavisDashboardShellRenderContext {
  request: Request;
  path: string;
}

export interface ZelavisDashboardShellResult {
  status?: number;
  headers?: HeadersInit;
  body?: unknown;
}

export interface ZelavisDashboardServiceOptions {
  title?: string;
  subtitle?: string;
  rootPath?: string;
  routes?: readonly ZelavisDashboardServiceRoute[];
  devServerUrl?: string;
  createRuntimeConfig: () => unknown | Promise<unknown>;
}

export const defaultZelavisDashboardClientRoutes = Object.freeze([
  "/access",
  "/access/permissions",
  "/access/users",
  "/assistant",
  "/marketplace",
  "/projects",
  "/resources",
  "/security",
  "/services",
  "/server",
  "/server/backups",
  "/server/domains",
  "/server/logs",
  "/settings",
  "/settings/appearance",
  "/projects/:projectId",
  "/projects/:projectId/agents",
  "/projects/:projectId/auth",
  "/projects/:projectId/commerce",
  "/projects/:projectId/commerce/customers",
  "/projects/:projectId/commerce/coupons",
  "/projects/:projectId/commerce/orders",
  "/projects/:projectId/commerce/products",
  "/projects/:projectId/content",
  "/projects/:projectId/content/new",
  "/projects/:projectId/database",
  "/projects/:projectId/database/new",
  "/projects/:projectId/media",
  "/projects/:projectId/marketplace",
  "/projects/:projectId/services",
  "/projects/:projectId/settings",
  "/projects/:projectId/settings/appearance",
  "/projects/:projectId/storage",
  "/projects/:projectId/users",
  "/projects/:projectId/website",
  "/projects/:projectId/workloads",
  "/projects/:projectId/workloads/functions/:workloadId",
  "/projects/:projectId/workloads/jobs/:workloadId",
  "/projects/:projectId/workloads/logs",
  "/projects/:projectId/workloads/new",
  "/projects/:projectId/workloads/schedules/:workloadId",
  "/projects/:projectId/workloads/settings",
  "/projects/:projectId/workloads/webhooks/:workloadId",
] as const);

interface DashboardAsset {
  path: string;
  contentType: string;
  cacheControl: string;
  kind: "text" | "base64";
  content: string;
}

const DASHBOARD_RUNTIME_ASSET_CACHE_KEY = "zelavis-runtime-v1";

function normalizeRootPath(path: string | undefined): string {
  if (!path || path === "/") {
    return "/";
  }

  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }

  const normalized = trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized ? `/${normalized}` : "/";
}

function joinPathParts(...parts: (string | undefined)[]): string {
  const normalized = parts
    .filter((part): part is string => Boolean(part))
    .flatMap((part) => part.split("/"))
    .filter(Boolean);

  return normalized.length > 0 ? `/${normalized.join("/")}` : "/";
}

function collectDashboardAssets(): DashboardAsset[] {
  return [...embeddedDashboardAssets]
    .map((asset: EmbeddedDashboardAsset) => ({
      path: asset.path,
      contentType: asset.contentType,
      cacheControl: asset.cacheControl,
      kind: asset.kind,
      content: asset.content,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function prefixDashboardAssetReferences(
  content: string,
  rootPath: string,
  options: { cacheAbsoluteAssets?: boolean } = {},
): string {
  const prefix = rootPath === "/" ? "" : rootPath;
  const barePrefix = prefix.replace(/^\/+/, "");
  const bareAssetPrefix = barePrefix ? `${barePrefix}/assets/` : "assets/";
  const maybeCacheAsset = (path: string) => {
    if (!options.cacheAbsoluteAssets) {
      return path;
    }

    return `${path}${path.includes("?") ? "&" : "?"}${DASHBOARD_RUNTIME_ASSET_CACHE_KEY}`;
  };
  const prefixAbsolutePath = (attribute: string, path: string) => {
    const nextPath = `${prefix}/${path}`;

    return `${attribute}="${path.startsWith("assets/") ? maybeCacheAsset(nextPath) : nextPath}"`;
  };
  const prefixQuotedAbsoluteAsset = (
    _match: string,
    quote: string,
    assetPath: string,
  ) => {
    return `${quote}${maybeCacheAsset(`${prefix}/assets/${assetPath}`)}`;
  };
  const prefixQuotedBareAsset = (
    _match: string,
    quote: string,
    assetPath: string,
  ) => {
    return `${quote}${bareAssetPrefix}${assetPath}`;
  };

  return content
    .replace(
      /("basename"\s*:\s*)"\/"/g,
      (_match, property: string) => `${property}${JSON.stringify(rootPath)}`,
    )
    .replace(
      /\b(href|src|action)="\/(?!\/)([^"]*)"/g,
      (_match, attribute, path) => {
        return prefixAbsolutePath(attribute, path);
      },
    )
    .replace(/(["'`])\/assets\/([^"'`\\\s<>)]*)/g, prefixQuotedAbsoluteAsset)
    .replace(/(["'`])assets\/([^"'`\\\s<>)]*)/g, prefixQuotedBareAsset);
}

function shouldPrefixDashboardAsset(asset: DashboardAsset): boolean {
  return (
    asset.contentType.startsWith("text/") ||
    asset.contentType.startsWith("application/json") ||
    asset.path.endsWith(".js") ||
    asset.path.endsWith(".mjs")
  );
}

function decodeBase64(base64: string): Uint8Array {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const sanitized = base64.replace(/=+$/, "");
  const output: number[] = [];

  for (let index = 0; index < sanitized.length; index += 4) {
    const c1 = alphabet.indexOf(sanitized[index] ?? "A");
    const c2 = alphabet.indexOf(sanitized[index + 1] ?? "A");
    const c3 = alphabet.indexOf(sanitized[index + 2] ?? "A");
    const c4 = alphabet.indexOf(sanitized[index + 3] ?? "A");
    const value = (c1 << 18) | (c2 << 12) | ((c3 & 63) << 6) | (c4 & 63);

    output.push((value >> 16) & 0xff);
    if (sanitized[index + 2] !== undefined) {
      output.push((value >> 8) & 0xff);
    }
    if (sanitized[index + 3] !== undefined) {
      output.push(value & 0xff);
    }
  }

  return Uint8Array.from(output);
}

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function readDashboardAsset(asset: DashboardAsset, rootPath: string): Uint8Array {
  if (!shouldPrefixDashboardAsset(asset)) {
    return asset.kind === "text"
      ? encodeText(asset.content)
      : decodeBase64(asset.content);
  }

  return encodeText(prefixDashboardAssetReferences(asset.content, rootPath));
}

function injectDashboardRuntimeConfig(html: string, config: unknown): string {
  const script = `<script>window.__ZELAVIS_RUNTIME_CONFIG__=${JSON.stringify(config).replaceAll("<", "\\u003c")};</script>`;
  return html.includes("</head>")
    ? html.replace("</head>", `${script}</head>`)
    : `${script}${html}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function createZelavisDashboardBundleStore(
  rootPathInput = "/zelavis",
): ZelavisDashboardBundleStore {
  const rootPath = normalizeRootPath(rootPathInput);
  const assets = collectDashboardAssets();
  const byKey = new Map<string, DashboardAsset>();
  for (const asset of assets) {
    byKey.set(asset.path, asset);
    byKey.set(asset.path.replace(/^\/+/, ""), asset);
  }

  return {
    read(_scope, path) {
      const asset = byKey.get(path) ?? byKey.get(path.replace(/^\/+/, ""));
      if (!asset) {
        return undefined;
      }

      const body = readDashboardAsset(asset, rootPath);
      return {
        path: asset.path,
        body,
        size: body.byteLength,
        contentType: asset.contentType,
        cacheControl: asset.cacheControl,
      };
    },
  };
}

export function createZelavisDashboardService(
  options: ZelavisDashboardServiceOptions,
) {
  const rootPath = normalizeRootPath(options.rootPath ?? "/zelavis");
  const title = options.title ?? "zelavis";
  const subtitle =
    options.subtitle ?? "Backend, dashboard, and core services.";
  const baseShell = embeddedDashboardShell
    ? prefixDashboardAssetReferences(embeddedDashboardShell, rootPath, {
        cacheAbsoluteAssets: true,
      })
    : undefined;

  const render = async ({
    request,
    path,
  }: ZelavisDashboardShellRenderContext): Promise<ZelavisDashboardShellResult> => {
    if (
      path === "api" ||
      path.startsWith("api/") ||
      path === "assets" ||
      path.startsWith("assets/")
    ) {
      return {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: { error: "Not found" },
      };
    }

    if (!baseShell) {
      return {
        status: 503,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
        },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p><p>Dashboard assets have not been built yet.</p></body></html>`,
      };
    }

    void request;

    return {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      },
      body: injectDashboardRuntimeConfig(
        baseShell,
        await options.createRuntimeConfig(),
      ),
    };
  };

  return Object.freeze({
    name: "@zelavis/ui",
    scope: "system",
    basePath: "/",
    menu: {
      title: "Dashboard",
      path: "/",
      surface: "root" as const,
    },
    service: {
      title,
      subtitle,
      assetRoot: joinPathParts(rootPath, "assets"),
    },
    app: {
      mount: "/" as const,
      mode: "spa" as const,
      domainPolicy: "optional" as const,
      shell: { render },
      devUrl: options.devServerUrl,
    },
    api: {
      v1: Object.freeze([...(options.routes ?? [])]),
    },
  });
}

export const dashboardService = createZelavisDashboardService({
  createRuntimeConfig: () => undefined,
});

export default dashboardService;
