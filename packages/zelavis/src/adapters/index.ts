export { zelavisFetch } from "./fetch.js";

export { expressAdapter, expressAdapter as zelavisExpress } from "./express.js";
export type { ZelavisExpressBinding, ZelavisExpressAdapterOptions } from "./express.js";

export { honoAdapter, honoAdapter as zelavisHono } from "./hono.js";
export type { ZelavisHonoBinding, ZelavisHonoAdapterOptions } from "./hono.js";

export { fastifyAdapter, fastifyAdapter as zelavisFastify } from "./fastify.js";
export type { ZelavisFastifyBinding, ZelavisFastifyAdapterOptions } from "./fastify.js";

export { h3Adapter, h3Adapter as zelavisH3 } from "./h3.js";
export type { ZelavisH3Binding, ZelavisH3AdapterOptions } from "./h3.js";

export { elysiaAdapter, elysiaAdapter as zelavisElysia } from "./elysia.js";
export type { ZelavisElysiaBinding, ZelavisElysiaAdapterOptions } from "./elysia.js";

export { nodeAdapter, nodeAdapter as zelavisNodeServer } from "./node.js";
export type { ZelavisNodeBinding, ZelavisNodeAdapterOptions } from "./node.js";

export {
  nextjsPagesRouterAdapter,
  nextjsPagesRouterAdapter as zelavisNextjsPagesRouter,
} from "./nextjs-pages-router.js";
export type {
  ZelavisNextjsPagesRouterBinding,
  ZelavisNextjsPagesRouterAdapterOptions,
} from "./nextjs-pages-router.js";

export { nodePlatform as zelavisNode } from "../platforms/node.js";
export { bunPlatform as zelavisBun } from "../platforms/bun.js";
export { cloudflarePlatform as zelavisCloudflare } from "../platforms/cloudflare.js";
export { netlifyPlatform as zelavisNetlify } from "../platforms/netlify.js";
export { vercelPlatform as zelavisVercel } from "../platforms/vercel.js";
