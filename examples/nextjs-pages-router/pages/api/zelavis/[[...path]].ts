import { nextjsPagesRouterIntegration } from "zelavis/integrations/nextjs-pages-router";
import { getZelavisRuntime } from "@/lib/zelavis";

export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

export default nextjsPagesRouterIntegration(getZelavisRuntime(), {
  routePrefix: "/api/zelavis",
  mountPath: "/zelavis",
});
