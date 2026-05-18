import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const zelavisDevServer =
  process.env.ZELAVIS_DEV_SERVER ?? "http://127.0.0.1:3000";
const zelavisUiBasePath = normalizeBasePath(
  process.env.ZELAVIS_UI_BASE_PATH ?? "/",
);

function normalizeBasePath(path: string): string {
  if (!path || path === "/") {
    return "/";
  }

  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  return `${withLeadingSlash.replace(/\/+$/, "")}/`;
}

export default defineConfig({
  base: zelavisUiBasePath,
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    alias: {
      "#": fileURLToPath(new URL("./app", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: zelavisDevServer,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, "/zelavis/api"),
      },
      "/zelavis/api": {
        target: zelavisDevServer,
        changeOrigin: true,
      },
    },
  },
});
