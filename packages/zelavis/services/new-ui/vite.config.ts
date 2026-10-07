import { defineConfig } from "vite";
import { fuzorPlugin } from "fuzor/vite";
import { clientRoutes, routeTree, databaseRoutes } from "./app/routes.ts";
const runtime = process.env.ZELAVIS_DEV_SERVER ?? "http://127.0.0.1:3000";
export default defineConfig({
  base: "/zelavis/",
  plugins: [fuzorPlugin({
    clientRoutes, routeTree,
    serverComponents: { server: "app/views/dashboard.server.ts", references: "app/views", routes: databaseRoutes },
    prefetch: "intent"
  })],
  resolve: { dedupe: ["effect", "react", "react-dom"] },
  server: {
    host: "127.0.0.1",
    fs: { allow: ["../../../../../fuzor", "../../../.."] },
    proxy: { "/zelavis/api": { target: runtime, changeOrigin: true, configure(proxy) {
      proxy.on("proxyReq", (request) => request.setHeader("origin", new URL(runtime).origin));
    } } }
  }
});
