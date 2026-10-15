import { serverNavigationMenu } from "./server-navigation.ts";
import { Effect } from "effect";
import { zelavis } from "zelavis/sdk";
import type { ZelavisPlatformFrontendContext } from "zelavis";
import { mountOf, requestIntoBuild, responseOutOfBuild } from "./mount-rewrite.ts";

export function register(context: Partial<ZelavisPlatformFrontendContext> = {}) {
  const mount = mountOf(context.rootPath ?? "/zelavis");
  let handler: ((request: Request) => Promise<Response>) | undefined;
  // The server-rendered views run in the build's own module graph, so the real mount and the Platform's `fetch` reach
  // them through globals set before the build's server entry is first imported.
  Object.defineProperty(globalThis, "__zelavisUiMount", { value: mount, configurable: true });
  if (context.fetch) Object.defineProperty(globalThis, "__zelavisDashboardPlatform", { value: Object.freeze({ fetch: context.fetch }), configurable: true });
  const render = ({ request, path }: { request: Request; path?: string }) => Effect.runPromise(Effect.gen(function*() {
    // Whatever reaches the shell under the API or asset prefixes matched no route there, so it is a real 404, not a page.
    if (path !== undefined && (path === "api" || path.startsWith("api/") || path === "assets" || path.startsWith("assets/"))) {
      return { status: 404, headers: { "content-type": "application/json; charset=utf-8" }, body: { error: "Not found" } };
    }
    if (!handler) {
      const module = yield* Effect.tryPromise({ try: () => import(new URL("../.fuzor/dist-backend/entry.mjs", import.meta.url).href), catch: cause => cause });
      if (typeof module.handler !== "function") return yield* Effect.fail(new Error("Dashboard build has no request handler."));
      handler = module.handler;
    }
    const entering = requestIntoBuild(request, mount);
    if (!entering) return { status: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: "Not found" };
    // The incoming request owns the response stream, beyond this handler Promise.
    const response = responseOutOfBuild(yield* Effect.tryPromise({ try: () => handler!(entering), catch: cause => cause }), mount);
    return { status: response.status, headers: Object.fromEntries(response.headers), body: response.body ?? undefined };
  }).pipe(Effect.timeout("30 seconds"), Effect.catchCause(cause => Effect.gen(function*() {
    yield* Effect.logError("Fuzor dashboard delivery failed", cause);
    return { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, body: "The dashboard build is unavailable. Run pnpm --filter @zelavis/ui build." };
  }))), { signal: request.signal });
  const api = zelavis.createAPI({ shell: { render } }, { routes: false });
  zelavis.plugins.ui.menus.create({ title: "Dashboard", path: "/", surface: "root" });
  zelavis.plugins.ui.menus.create(serverNavigationMenu);
  zelavis.frontend.configure({ shell: api.shell, devUrl: context.devServerUrl, devUrlExcludePaths: ["api"] });
}
