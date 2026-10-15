import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import { defineConfig, type PluginOption } from "vite";
import { fuzorPlugin } from "fuzor/vite";
import { clientRoutes, routeTree, databaseRoutes } from "./app/routes.ts";
const runtime = process.env.ZELAVIS_DEV_SERVER ?? "http://127.0.0.1:3000";
const workspaceStyles = fileURLToPath(new URL("../zelavis-ui/app/styles.css", import.meta.url));
export default defineConfig({
  base: "/zelavis/",
  plugins: [{ name: "new-ui:workspace-styles", enforce: "pre", load(id) {
    if (id.split("?")[0] !== workspaceStyles) return;
    // Scan the React workspace sources, avoiding Fuzor's server templates in
    // Tailwind's CSS watch graph. The authored stylesheet stays untouched.
    return Effect.runPromise(Effect.tryPromise({ try: () => readFile(workspaceStyles, "utf8"), catch: cause => cause }).pipe(Effect.map(css => css.replace('@import "tailwindcss";', '@import "tailwindcss" source(none);\n@source ".";') + '\n/* The feature frame has no React shell header: retain its own Projects controls. */\n.workspace-projects [class~="lg:hidden"] { display: flex; }\n')));
  } }, tailwindcss() as unknown as PluginOption, fuzorPlugin({
    clientRoutes, routeTree,
    serverComponents: { server: "app/views/dashboard.server.ts", references: "app/views", routes: databaseRoutes },
    prefetch: "intent"
  })],
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "#": fileURLToPath(new URL("../zelavis-ui/app", import.meta.url)) }, dedupe: ["effect", "react", "react-dom"] },
  server: {
    host: "127.0.0.1",
    fs: { allow: ["../../../../../fuzor", "../../../.."] },
    proxy: { "/zelavis/api": { target: runtime, changeOrigin: true, configure(proxy) {
      proxy.on("proxyReq", (request) => request.setHeader("origin", new URL(runtime).origin));
    } } }
  }
});
