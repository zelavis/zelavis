import { nextjsPagesRouterAdapter } from "zelavis/adapters/nextjs-pages-router";
import { getZelavisRuntime } from "@/lib/zelavis";

export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

export default nextjsPagesRouterAdapter(getZelavisRuntime(), {
  routePrefix: "/api/zelavis",
  mountPath: "/zelavis",
});
