import { getZelavis } from "@/lib/zelavis";

export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

export default getZelavis().adapter.nextjsPagesRouterHandler({
  routePrefix: "/api/zelavis",
  mountPath: "/zelavis",
});
