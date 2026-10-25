import { readFile, readdir, stat } from "node:fs/promises";
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
  // The component runtime service pages are given (scripts/build-service-ui.mjs); a checkout that has not built it offers none.
  const readRuntimeFile = (name: string) => Effect.tryPromise({ try: () => readFile(resolve(root, "service-ui", name), "utf8"), catch: cause => new AssetReadError({ message: `Could not read the service page runtime ${name}.`, cause }) }).pipe(
    Effect.map((text): string | undefined => text),
    Effect.catch(error => error.cause && typeof error.cause === "object" && "code" in error.cause && error.cause.code === "ENOENT" ? Effect.succeed(undefined) : Effect.fail(error)),
  );
  const [serviceUiScript, serviceUiStylesheet] = yield* Effect.all([readRuntimeFile("service-ui.js"), readRuntimeFile("service-ui.css")]);
  // Snapshot only the isolated build directory at composition. Requests never select a filesystem path.
  const modules: Record<string, string> = Object.create(null);
  if (serviceUiScript !== undefined && serviceUiStylesheet !== undefined) {
    const directory = resolve(root, "service-ui/service-ui");
    const files = yield* Effect.tryPromise({ try: () => readdir(directory, { withFileTypes: true }), catch: cause => new AssetReadError({ message: "Could not read service-page build modules.", cause }) });
    if (files.length > 127 || files.some(file => !file.isFile() || file.name.length > 160 || !/^[a-zA-Z0-9_-]+-[a-zA-Z0-9_-]{8}\.js$/.test(file.name))) {
      return yield* new AssetReadError({ message: "Invalid service-page build module directory.", cause: directory });
    }
    const sizes = yield* Effect.forEach(files, file => Effect.tryPromise({ try: () => stat(resolve(directory, file.name)), catch: cause => new AssetReadError({ message: "Could not measure service-page build module.", cause }) }).pipe(Effect.map(info => info.size)), { concurrency: 4 });
    if (sizes.some(size => size > 2 * 1024 * 1024) || sizes.reduce((sum, size) => sum + size, 0) > 8 * 1024 * 1024) {
      return yield* new AssetReadError({ message: "Service-page build modules exceed the size limit.", cause: directory });
    }
    yield* Effect.forEach(files, file => Effect.tryPromise({ try: () => readFile(resolve(directory, file.name), "utf8"), catch: cause => new AssetReadError({ message: "Could not read service-page build module.", cause }) }).pipe(Effect.tap(text => Effect.sync(() => { modules[file.name] = text; }))), { concurrency: 4, discard: true });
  }
  return {
    service,
    servicePageStylesheet: zelavisServicePageStylesheet,
    ...(serviceUiScript !== undefined && serviceUiStylesheet !== undefined ? { serviceUi: { script: serviceUiScript, stylesheet: serviceUiStylesheet, modules } } : {}),
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
