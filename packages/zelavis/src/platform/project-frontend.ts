/**
 * Placeholder frontend for a Project that has not selected one yet.
 *
 * A Project hosts its own public site, but the thing that renders it is chosen
 * by the developer — a static bundle, or a full application with its own server.
 * Until one is installed, `/` would otherwise 404, which reads as a broken
 * Project rather than an unfinished one.
 *
 * This is deliberately not a content model. The retired website service owned a
 * fixed page shape and a single hardcoded template, which is a worse version of
 * what a real Frontend provides. This service only says "nothing is installed
 * yet, here is where to get one".
 */
import type { ZelavisRuntimeService } from "../core/index.js";

export interface ZelavisProjectFrontendPlaceholderOptions {
  /** Shown as the page heading. Defaults to the Project or Platform name. */
  readonly title?: string;
  /** Dashboard path where a Frontend can be chosen. */
  readonly marketplacePath?: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Renders the placeholder.
 *
 * Deliberately one small self-contained document with no assets: it must render
 * correctly on a Project that has nothing installed, which is exactly the state
 * where an asset pipeline cannot be assumed.
 */
export function renderProjectFrontendPlaceholder(
  options: ZelavisProjectFrontendPlaceholderOptions = {},
): string {
  const title = escapeHtml(options.title ?? "This Zelavis Project");
  const marketplacePath = escapeHtml(options.marketplacePath ?? "/zelavis");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${title}</title>
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
      h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
      p { margin: 0 0 1rem; opacity: 0.8; }
      a {
        display: inline-block;
        padding: 0.6rem 1rem;
        border: 1px solid currentColor;
        border-radius: 0.5rem;
        text-decoration: none;
        color: inherit;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${title} has no frontend yet</h1>
      <p>
        This Project is running. Choose a frontend to serve here, or upload your
        own — a static site, or an application that brings its own server.
      </p>
      <a href="${marketplacePath}">Open the dashboard</a>
    </main>
  </body>
</html>
`;
}

export interface ZelavisProjectFrontendServiceOptions
  extends ZelavisProjectFrontendPlaceholderOptions {
  /** Paths owned by the runtime, which must never be served the placeholder. */
  readonly reservedPrefixes?: readonly string[];
}

/**
 * Serves the placeholder for public paths a Project does not otherwise handle.
 *
 * Reserved prefixes are left alone so the control plane and API keep their own
 * 404s: a request to a mistyped API path should not be answered with a page.
 */
export function createProjectFrontendPlaceholderService(
  options: ZelavisProjectFrontendServiceOptions = {},
): ZelavisRuntimeService<Record<string, never>> {
  const reserved = options.reservedPrefixes ?? ["/zelavis", "/api"];

  const isReserved = (path: string): boolean =>
    reserved.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

  return {
    name: "@zelavis/frontend",
    // Mounted at the root: this is the Project's public front door, not an API.
    basePath: "/",
    menu: {
      title: "Frontend",
      path: "/frontend",
      pageLabel: "Frontend",
      sectionLabel: "Build",
      surface: "root" as const,
      access: {
        permissions: ["project.website.manage"],
        scope: { type: "project" as const, projectIdParam: "projectId" },
      },
    },
    service: {},
    api: {
      v1: [
      {
        id: "project.frontend.placeholder",
        method: "GET" as const,
        path: "/*path",
        // Intentionally no access requirement: this is the Project's own
        // front door, seen by visitors who have no Platform identity. The
        // privileged route audit treats public data-plane routes as explicit.
        handler: ({ request }: { request: Request }) => {
          const path = new URL(request.url).pathname;
          if (isReserved(path)) {
            return { status: 404, body: { error: "Not found" } };
          }

          return {
            // 503, not 200: the Project is reachable but cannot serve content
            // yet, and a search engine should not index the placeholder.
            status: 503,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
            },
            body: renderProjectFrontendPlaceholder(options),
          };
        },
      },
      ],
    },
  };
}
