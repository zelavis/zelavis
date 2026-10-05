import { Effect } from "effect";
import { evaluate, integration } from "../core/runtime/effect-boundary.js";
import type { ZelavisEdgeManager } from "./index.js";
import { toPublicationSummary, type ZelavisEdgeRouteStore } from "./routes.js";

/** Production ingress is Platform state, compiled by the ordinary Edge adapter. */
export const ensureProductionEdge = Effect.fn("Edge.ensureProductionIngress")(function* (options: {
  readonly routes: ZelavisEdgeRouteStore;
  readonly manager: ZelavisEdgeManager;
  readonly port: number;
}) {
  yield* evaluate(() => {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535 || [80, 443].includes(options.port)) {
      throw new Error("The Platform management listener must use a port distinct from production ingress ports 80 and 443.");
    }
  });
  const target = `http://127.0.0.1:${options.port}`;
  const existing = yield* integration(() => options.routes.getRoute("platform:default"));
  const matches = existing?.hostname === "*" && existing.scope === "platform" && existing.pathPrefix === "/" &&
    existing.pathMatch === "prefix" && existing.priority === 1 && existing.targets.length === 1 &&
    existing.targets[0]?.url === target && existing.targets[0]?.weight === 100 &&
    JSON.stringify(existing.protocols) === JSON.stringify(["http", "websocket", "sse"]);
  if (!matches) {
    const timestamp = new Date().toISOString();
    yield* integration(() => options.routes.putRoute({ id: "platform:default", scope: "platform", hostname: "*",
      pathPrefix: "/", pathMatch: "prefix", priority: 1, protocols: ["http", "websocket", "sse"],
      targets: [{ url: target, weight: 100 }], createdAt: timestamp, updatedAt: timestamp }));
  }
  let publication = yield* integration(() => options.routes.getCurrentPublication());
  const published = publication?.routes.find(route => route.id === "platform:default");
  if (!matches || !published || JSON.stringify(published) !== JSON.stringify(existing)) {
    publication = yield* integration(() => options.routes.compile());
  }
  const policy = yield* integration(() => options.manager.getPolicy());
  const adapters = yield* integration(() => options.manager.listAdapters());
  if (policy.activeAdapterId === "traefik" && policy.activePublication?.revision === String(publication!.revision) &&
    adapters.some(adapter => adapter.id === "traefik" && adapter.detection.detail === "active")) return;
  yield* integration(() => options.manager.switchAdapter("traefik", toPublicationSummary(publication!)));
});
