import { serverNavigationMenu } from "../app/workspace-route-manifest.ts";
import { Effect } from "effect";
import { zelavis } from "zelavis/sdk";
import type { ZelavisPlatformFrontendContext } from "zelavis";

export function register(context: ZelavisPlatformFrontendContext) {
  if (context.rootPath !== "/zelavis") throw new Error("The experimental dashboard currently mounts at /zelavis.");
  let handler: ((request: Request) => Promise<Response>) | undefined;
  const render = ({ request }: { request: Request }) => Effect.runPromise(Effect.gen(function*() {
    if (!handler) {
      const module = yield* Effect.tryPromise({ try: () => import(new URL("../.fuzor/dist-spa-server/server/entry.mjs", import.meta.url).href), catch: cause => cause });
      if (typeof module.handler !== "function") return yield* Effect.fail(new Error("Dashboard build has no request handler."));
      handler = module.handler;
    }
    // The incoming request owns the response stream, beyond this handler Promise.
    const response = yield* Effect.tryPromise({ try: () => handler!(request), catch: cause => cause });
    return { status: response.status, headers: Object.fromEntries(response.headers), body: response.body ?? undefined };
  }).pipe(Effect.timeout("30 seconds"), Effect.catchCause(cause => Effect.gen(function*() {
    yield* Effect.logError("Fuzor dashboard delivery failed", cause);
    return { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, body: "The dashboard build is unavailable. Run pnpm --filter @zelavis/new-ui build:fuzor." };
  }))), { signal: request.signal });
  const api = zelavis.createAPI({ shell: { render } }, { routes: false });
  zelavis.plugins.ui.menus.create({ title: "Dashboard", path: "/", surface: "root" });
  zelavis.plugins.ui.menus.create(serverNavigationMenu);
  zelavis.frontend.configure({ shell: api.shell, devUrl: context.devServerUrl, devUrlExcludePaths: ["api"] });
}
