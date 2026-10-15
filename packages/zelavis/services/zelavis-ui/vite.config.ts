import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import { defineConfig, type PluginOption } from "vite";
import { fuzorPlugin } from "fuzor/vite";
import { clientRoutes, routeTree, databaseRoutes } from "./app/routes.ts";
const runtime = process.env.ZELAVIS_DEV_SERVER ?? "http://127.0.0.1:3000";
// A build is compiled against a placeholder root that the frontend adapter replaces with the Platform's `rootPath`
// (src/mount-rewrite.ts); the dev server has no adapter in front of it, so it mounts at `/zelavis` (ZELAVIS_UI_BASE_PATH).
const mount = process.env.ZELAVIS_UI_BASE_PATH ? process.env.ZELAVIS_UI_BASE_PATH.replace(/\/+$/, "") : "/__zelavis__";
const workspaceStyles = fileURLToPath(new URL("../zelavis-ui-legacy/app/styles.css", import.meta.url));
export default defineConfig(({ isSsrBuild }) => ({
  base: `${mount}/`,
  // The client carries the placeholder, which the adapter replaces as it serves. The server entry is loaded by the
  // adapter, which knows the real mount and shares it as `globalThis.__zelavisUiMount` before the first import.
  define: { __ZELAVIS_ROOT__: isSsrBuild ? "globalThis.__zelavisUiMount" : JSON.stringify(mount) },
  plugins: [{ name: "new-ui:workspace-styles", enforce: "pre", load(id) {
    if (id.split("?")[0] !== workspaceStyles) return;
    // Scan the React workspace sources, avoiding Fuzor's server templates in
    // Tailwind's CSS watch graph. The authored stylesheet stays untouched.
    return Effect.runPromise(Effect.tryPromise({ try: () => readFile(workspaceStyles, "utf8"), catch: cause => cause }).pipe(Effect.map(css => css.replace('@import "tailwindcss";', '@import "tailwindcss" source(none);\n@source ".";') + '\n/* The feature frame has no React shell header: retain its own Projects controls. */\n.workspace-projects [class~="lg:hidden"] { display: flex; }\n')));
  } }, tailwindcss() as unknown as PluginOption, fuzorPlugin({
    clientRoutes, routeTree,
    // The Platform provides `effect` to the services it loads; Fuzor's server runtime is bundled into the entry so
    // the shipped dashboard needs nothing installed beside it.
    serverExternal: ["effect"],
    serverComponents: { server: "app/views/dashboard.server.ts", references: "app/views", routes: databaseRoutes },
    prefetch: "intent"
  })],
  // The dashboard targets current browsers. Vite's default list (down to safari14) asks esbuild to downlevel
  // destructuring, which the esbuild a clean install resolves refuses to do.
  build: { target: "es2022" },
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "#": fileURLToPath(new URL("../zelavis-ui-legacy/app", import.meta.url)) }, dedupe: ["effect", "react", "react-dom"] },
  server: {
    host: "127.0.0.1",
    fs: { allow: ["../../../../../fuzor", "../../../.."] },
    proxy: { [`${mount}/api`]: { target: runtime, changeOrigin: true, configure(proxy) {
      proxy.on("proxyReq", (request) => request.setHeader("origin", new URL(runtime).origin));
    } } }
  }
}));
