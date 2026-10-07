import { readFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Data, Effect } from "effect";
import { loadPluginPackage } from "zelavis/service";
import type { ZelavisPlatformFrontendContext, ZelavisPlatformFrontend } from "zelavis";
import manifest from "../package.json" with { type: "json" };
class AssetReadError extends Data.TaggedError("AssetReadError")<{ message: string; cause: unknown }> {}
const root = fileURLToPath(new URL("../dist-spa-server/client/", import.meta.url));
const types: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2" };
export const newUiFrontend = (context: ZelavisPlatformFrontendContext): Promise<ZelavisPlatformFrontend> => Effect.runPromise(Effect.gen(function*() {
  const service = yield* Effect.tryPromise({ try: () => loadPluginPackage({ manifest, scope: "system", configuration: context, importer: () => import("./new-ui-service.ts") }), catch: cause => new AssetReadError({ message: cause instanceof Error ? cause.message : "Could not load the Fuzor frontend.", cause }) });
  return {
    service,
    clientRoutes: ["/", "/projects", "/projects/*", "/server", "/server/*", "/marketplace", "/settings", "/settings/*", "/assistant", "/setup", "/login"],
    bundleStore: {
      read(_scope, path) {
        const relative = path.replace(/^\/+/, "");
        const target = resolve(root, relative);
        if (!target.startsWith(`${resolve(root)}${sep}`) || !relative.startsWith("assets/")) return Promise.resolve(undefined);
        return Effect.runPromise(Effect.tryPromise({ try: () => readFile(target), catch: cause => new AssetReadError({ message: "Could not read a dashboard asset.", cause }) }).pipe(
          Effect.map(body => ({ path: relative, body: new Uint8Array(body), size: body.byteLength, contentType: types[extname(target)] ?? "application/octet-stream", cacheControl: relative === "assets/grid-licenses.txt" ? "no-cache" : "public, max-age=31536000, immutable" })),
          Effect.catch(error => {
            if (error.cause && typeof error.cause === "object" && "code" in error.cause && error.cause.code === "ENOENT") return Effect.succeed(undefined);
            return Effect.fail(error);
          })
        ));
      }
    }
  } satisfies ZelavisPlatformFrontend;
}));
export default newUiFrontend;
