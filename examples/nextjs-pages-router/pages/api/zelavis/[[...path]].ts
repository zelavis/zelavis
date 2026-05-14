import { nextjsPagesRouterHandler } from "zelavis/nextjs/pages";
import { getZelavis } from "@/lib/zelavis";

export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

export default nextjsPagesRouterHandler(getZelavis(), {
  routePrefix: "/api/zelavis",
  mountPath: "/zelavis",
});
