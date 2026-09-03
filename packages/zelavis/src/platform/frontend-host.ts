/**
 * What the Platform needs from whatever serves its root path.
 *
 * The Platform does not know any frontend by name. A frontend is a service
 * like any other — `@zelavis/ui` is one, a third-party theme is another — and
 * the Platform serves whichever one it was given, or says none is installed.
 *
 * That matters beyond tidiness: the web API must work on an installation with
 * no frontend at all. Everything the dashboard does, it does through the same
 * versioned endpoints anything else uses, so removing the frontend removes the
 * face and nothing else.
 */
import type { ZelavisRuntimeService } from "../core/index.js";
import type { BundleStore } from "../bundle-store.js";

export interface ZelavisPlatformFrontendContext {
  /** Path the installation is mounted at, e.g. `/zelavis`. */
  readonly rootPath: string;
  readonly title?: string;
  readonly subtitle?: string;
  /** Dev server to proxy to while developing the frontend. */
  readonly devServerUrl?: string;
  /**
   * The runtime configuration document. A frontend may embed it to save a
   * round trip; one that does not simply fetches `/runtime/config`.
   */
  readonly createRuntimeConfig: () => Promise<unknown>;
}

export interface ZelavisPlatformFrontend {
  /** Service that serves the frontend at the installation's root path. */
  readonly service: ZelavisRuntimeService<any>;
  /** Serves the frontend's own assets, when it ships any. */
  readonly bundleStore?: BundleStore;
  /**
   * Paths the frontend resolves client-side.
   *
   * Advertised in the runtime configuration so a client knows which paths it
   * owns. A frontend that routes everything itself supplies none.
   */
  readonly clientRoutes?: readonly string[];
  /**
   * Stylesheet a service page links for the installation's design tokens.
   *
   * Supplied by the frontend because a design system belongs to a frontend,
   * not to the Platform. Without one the Platform serves a neutral baseline so
   * a service page still renders legibly rather than unstyled.
   */
  readonly servicePageStylesheet?: string;
}

export type ZelavisPlatformFrontendFactory = (
  context: ZelavisPlatformFrontendContext,
) => ZelavisPlatformFrontend | Promise<ZelavisPlatformFrontend>;

/**
 * Design tokens for a service page when no frontend supplies any.
 *
 * System colours only. The Platform has no palette of its own to impose, and a
 * service page rendering in the browser's own colours is legible; one rendering
 * against undefined custom properties is not.
 */
export const ZELAVIS_BASELINE_SERVICE_PAGE_STYLESHEET = `/* Zelavis baseline: no frontend supplied a design system. */
:root {
  color-scheme: light dark;
  --background: Canvas;
  --foreground: CanvasText;
  --card: Canvas;
  --card-foreground: CanvasText;
  --muted-foreground: color-mix(in srgb, CanvasText 65%, transparent);
  --border: color-mix(in srgb, CanvasText 20%, transparent);
  --primary: LinkText;
  --primary-foreground: Canvas;
  --destructive: color-mix(in srgb, red 70%, CanvasText);
}

* { box-sizing: border-box; }

/* An explicit \`display\` beats the user-agent rule for \`hidden\`, so a page that
   styles an element as flex or grid silently un-hides it. */
[hidden] { display: none !important; }

body {
  margin: 0;
  padding: 1.5rem;
  font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
  background: transparent;
  color: var(--foreground);
}

h1, h2, h3 { margin: 0 0 0.5rem; line-height: 1.25; font-weight: 600; }
h1 { font-size: 1.25rem; }
p { margin: 0 0 1rem; color: var(--muted-foreground); }
a { color: var(--primary); }

.zv-card {
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: var(--card);
  color: var(--card-foreground);
  padding: 1rem 1.25rem;
}

.zv-stack { display: grid; gap: 0.75rem; }
.zv-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.zv-muted { color: var(--muted-foreground); font-size: 0.8125rem; }

.zv-badge {
  display: inline-block;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  border: 1px solid var(--border);
  font-size: 0.75rem;
  color: var(--muted-foreground);
}

.zv-button {
  font: inherit;
  padding: 0.375rem 0.875rem;
  border-radius: 0.5rem;
  border: 1px solid transparent;
  background: var(--primary);
  color: var(--primary-foreground);
  cursor: pointer;
}

.zv-button:disabled { opacity: 0.5; cursor: default; }
.zv-button[data-variant="outline"] {
  background: transparent;
  color: var(--foreground);
  border-color: var(--border);
}
`;

/**
 * Serves the installation's root path when no frontend is installed.
 *
 * Self-contained by necessity — one document, no assets, no design tokens. It
 * renders in exactly the state where nothing else can be assumed to exist, and
 * it exists so that state is explained rather than shown as a 404.
 *
 * The API is unaffected. Everything the Platform can do stays reachable through
 * its versioned endpoints, which is what makes a frontend removable at all.
 */
export function createMissingPlatformFrontendService(options: {
  readonly rootPath: string;
  readonly title?: string;
  /**
   * Paths this page must not answer for.
   *
   * It is mounted at the root path, so without this a mistyped API path would
   * render a friendly page instead of the 404 a
   * client needs to see.
   */
  readonly reservedPrefixes?: readonly string[];
}): ZelavisRuntimeService<Record<string, never>> {
  const reserved = options.reservedPrefixes ?? [];
  const isReserved = (path: string) =>
    reserved.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  const title = options.title ?? "Zelavis";
  const escape = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escape(title)}</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
        background: Canvas;
        color: CanvasText;
      }
      main { max-width: 34rem; padding: 2rem; }
      h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
      p { margin: 0 0 0.75rem; opacity: 0.75; }
      ul { margin: 0; padding-left: 1.1rem; opacity: 0.75; }
      li { margin-bottom: 0.35rem; }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.875em;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>No frontend installed</h1>
      <p>
        This Zelavis installation is running and its API is available. Nothing
        is serving this page yet.
      </p>
      <p>Install one:</p>
      <ul>
        <li>from the marketplace, over the API or the <code>zelavis</code> CLI</li>
        <li>by placing a frontend package in <code>product-services</code> on this server</li>
      </ul>
      <p>
        A frontend is an ordinary service that declares
        <code>"zelavis": { "kind": "frontend" }</code>. The API works with or
        without one.
      </p>
    </main>
  </body>
</html>
`;

  return {
    name: "@zelavis/no-frontend",
    kind: "frontend" as const,
    basePath: options.rootPath,
    service: {},
    api: {
      v1: [
        {
          id: "platform.frontend.missing",
          method: "GET" as const,
          path: "/*path",
          // No access requirement: this is the installation's front door, seen
          // by whoever opens it, including someone who has not signed in
          // because there is no page to sign in on.
          handler: async ({ request }: { request: Request }) => {
            const pathname = new URL(request.url).pathname;
            if (isReserved(pathname)) {
              return { status: 404, body: { error: "Not found" } };
            }
            // Only the front door itself. An installed frontend claims every
            // path beneath it because it routes them client-side; this page
            // routes nothing, so answering a mistyped path with 200 HTML would
            // dress up a typo as a working page.
            const root = options.rootPath.replace(/\/+$/u, "");
            if (pathname.replace(/\/+$/u, "") !== root) {
              return { status: 404, body: { error: "Not found" } };
            }

            return {
              status: 200,
              headers: new Headers({
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-store",
              }),
              body,
            };
          },
        },
      ],
    },
  };
}
