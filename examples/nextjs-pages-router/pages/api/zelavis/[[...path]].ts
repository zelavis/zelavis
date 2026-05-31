import { nextjsPagesRouterHandler } from "zelavis/nextjs/pages";
import { zv } from "@/lib/zelavis";

export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

export default nextjsPagesRouterHandler(zv, {
  routePrefix: "/api/zelavis",
  mountPath: "/zelavis",
});
