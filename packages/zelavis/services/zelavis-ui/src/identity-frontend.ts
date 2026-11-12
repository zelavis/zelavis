import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import { loadPluginPackage } from "zelavis/service";
import type { ZelavisPlatformFrontendFactory } from "zelavis";
import manifest from "@zelavis/ui/package.json" with { type: "json" };
import { identityAssets, identityPagePaths } from "./identity-frontend-service.ts";

/** The App engine selects the auth frontend independently of its site frontend. */
export const zelavisUiIdentityFrontend: ZelavisPlatformFrontendFactory = context => Effect.runPromise(Effect.gen(function* () {
  const assets = new Map(yield* Effect.forEach(Object.entries(identityAssets), ([path, { file, type }]) =>
    Effect.tryPromise({
      try: () => readFile(new URL(`./identity-assets/${file}`, import.meta.url)),
      catch: cause => new Error(`Could not read the bundled App auth asset ${file}.`, { cause }),
    }).pipe(Effect.map(body => [path, { body: new Uint8Array(body), type }] as const)), { concurrency: 2 }));
  const registered = yield* Effect.tryPromise({
    try: () => loadPluginPackage({ manifest, scope: "system", configuration: { context, assets }, importer: () => import("./identity-frontend-service.ts") }),
    catch: cause => new Error("Could not load the bundled App auth frontend.", { cause }),
  });
  const shell = registered.app?.shell;
  if (!shell) return yield* Effect.fail(new Error("The App auth frontend did not register its renderer."));
  // These routes mount directly under the runtime root, without the dashboard's wildcard shell or plugin API namespace.
  return {
    appPublicAuth: true,
    service: { ...registered, namespace: undefined, api: { v1: [...identityPagePaths, ...assets.keys()].map(path => ({
      id: `app.identity.frontend${path.replaceAll("/", ".")}`,
      method: "GET" as const,
      path,
      handler: ({ request }: { request: Request }) => shell.render({ request, path }),
    })) } },
  };
}));
