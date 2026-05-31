import { nextjsPagesRouterHandler } from "zelavis/nextjs/pages";
import { zelavis } from "@/lib/zelavis";

export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

export default nextjsPagesRouterHandler(zelavis, {
  routePrefix: "/api/zelavis",
  mountPath: "/zelavis",
});
