import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const zelavisDevServer =
  process.env.ZELAVIS_DEV_SERVER ?? "http://127.0.0.1:3000";
const zelavisUiBasePath = normalizeBasePath(
  process.env.ZELAVIS_UI_BASE_PATH ?? "/",
);

/**
 * Dev proxy to the Zelavis runtime.
 *
 * `changeOrigin` only rewrites `Host`, so the browser's `Origin` header
 * (the dev server, e.g. http://127.0.0.1:3001) would still reach a runtime
 * serving a different origin (e.g. http://127.0.0.1:3000). The runtime issues
 * session cookies only to same-origin requests and would silently drop every
 * `set-cookie`, leaving login apparently successful but unauthenticated.
 *
 * The request genuinely is same-origin from the browser's point of view — the
 * proxy is transparent — so forward the runtime's own origin.
 */
const runtimeProxy = {
  target: zelavisDevServer,
  changeOrigin: true,
  configure: (proxy: { on: (event: string, handler: (...args: any[]) => void) => void }) => {
    proxy.on("proxyReq", (proxyReq: { setHeader: (name: string, value: string) => void }) => {
      proxyReq.setHeader("origin", new URL(zelavisDevServer).origin);
    });
  },
};

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
      "@base-ui/react/collapsible",
      "@base-ui/react/dialog",
      "@base-ui/react/direction-provider",
      "@base-ui/react/input",
      "@base-ui/react/menu",
      "@base-ui/react/merge-props",
      "@base-ui/react/select",
      "@base-ui/react/separator",
      "@base-ui/react/switch",
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
        ...runtimeProxy,
        rewrite: (path) => path.replace(/^\/api/, "/zelavis/api"),
      },
      "/zelavis/api": runtimeProxy,
    },
  },
});
