import { Zelavis } from "zelavis";
import { nextjsPagesRouterAdapter } from "zelavis/adapters/nextjs-pages-router";

export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

const zelavis = new Zelavis({
  adapter: nextjsPagesRouterAdapter(),
});

export default zelavis.adapter.nextjsPagesRouterHandler({
  routePrefix: "/api/zelavis",
  mountPath: "/zelavis",
});
