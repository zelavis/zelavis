import { readFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Data, Effect } from "effect";
import { loadPluginPackage } from "zelavis/service";
import type { ZelavisPlatformFrontendContext, ZelavisPlatformFrontend } from "zelavis";
import manifest from "@zelavis/ui/package.json" with { type: "json" };
import { zelavisServicePageStylesheet } from "./generated/service-page-styles.ts";
import { isTextual, mountOf, replacePlaceholder } from "./mount-rewrite.ts";
class AssetReadError extends Data.TaggedError("AssetReadError")<{ message: string; cause: unknown }> {}
const root = fileURLToPath(new URL("../.fuzor/web/dist-spa/", import.meta.url));
const types: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2" };
/** The Zelavis dashboard, built with Fuzor, as a Platform frontend. */
export const zelavisUiFrontend = (context: ZelavisPlatformFrontendContext): Promise<ZelavisPlatformFrontend> => Effect.runPromise(Effect.gen(function*() {
  const mount = yield* Effect.try({ try: () => mountOf(context.rootPath), catch: cause => new AssetReadError({ message: cause instanceof Error ? cause.message : "Invalid dashboard mount.", cause }) });
  // Built assets are immutable, so each is rewritten for this mount once.
  const rewritten = new Map<string, Uint8Array>();
  const forMount = (path: string, contentType: string, body: Uint8Array): Uint8Array => {
    if (!isTextual(contentType)) return body;
    const known = rewritten.get(path);
    if (known) return known;
    const text = new TextEncoder().encode(replacePlaceholder(new TextDecoder().decode(body), mount));
    rewritten.set(path, text);
    return text;
  };
  const service = yield* Effect.tryPromise({ try: () => loadPluginPackage({ manifest, scope: "system", configuration: context, importer: () => import("./dashboard-service.ts") }), catch: cause => new AssetReadError({ message: cause instanceof Error ? cause.message : "Could not load the Fuzor frontend.", cause }) });
  return {
    service,
    servicePageStylesheet: zelavisServicePageStylesheet,
    clientRoutes: ["/*", "/", "/projects", "/projects/*", "/server", "/server/*", "/marketplace", "/settings", "/settings/*", "/assistant", "/setup", "/login"],
    bundleStore: {
      read(_scope, path) {
        const relative = path.replace(/^\/+/, "");
        const target = resolve(root, relative);
        if (!target.startsWith(`${resolve(root)}${sep}`) || !relative.startsWith("assets/")) return Promise.resolve(undefined);
        return Effect.runPromise(Effect.tryPromise({ try: () => readFile(target), catch: cause => new AssetReadError({ message: "Could not read a dashboard asset.", cause }) }).pipe(
          Effect.map(file => { const contentType = types[extname(target)] ?? "application/octet-stream"; const body = forMount(relative, contentType, new Uint8Array(file)); return { path: relative, body, size: body.byteLength, contentType, cacheControl: relative === "assets/grid-licenses.txt" ? "no-cache" : "public, max-age=31536000, immutable" }; }),
          Effect.catch(error => {
            if (error.cause && typeof error.cause === "object" && "code" in error.cause && error.cause.code === "ENOENT") return Effect.succeed(undefined);
            return Effect.fail(error);
          })
        ));
      }
    }
  } satisfies ZelavisPlatformFrontend;
}));
export default zelavisUiFrontend;
