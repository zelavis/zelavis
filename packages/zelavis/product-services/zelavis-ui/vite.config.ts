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
  optimizeDeps: {
    include: [
      "@assistant-ui/core",
      "@assistant-ui/react",
      "@assistant-ui/store",
      "@base-ui/react/avatar",
      "@base-ui/react/button",
      "@base-ui/react/dialog",
      "@base-ui/react/input",
      "@base-ui/react/menu",
      "@base-ui/react/merge-props",
      "@base-ui/react/select",
      "@base-ui/react/separator",
      "@base-ui/react/tooltip",
      "@base-ui/react/use-render",
      "class-variance-authority",
      "clsx",
      "embla-carousel-react",
      "lucide-react",
      "swiper/react",
      "tailwind-merge",
    ],
  },
  resolve: {
    dedupe: [
      "@assistant-ui/core",
      "@assistant-ui/react",
      "@assistant-ui/store",
      "react",
      "react-dom",
      "react/jsx-runtime",
    ],
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
