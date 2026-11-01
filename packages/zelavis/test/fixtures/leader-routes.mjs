// The leader's follower routes as a Project proxy reaches them: a request path below the database service is
// matched to its route and answered by the route's own handler, as the Platform's dispatcher would.
import { defineDatabaseService } from "../../dist/db/index.js";

export const PROXY = "/zelavis/api/v1/runtime/projects/p1/proxy/zelavis/api/v1/database";

const OPERATOR = { id: "operator", kind: "service", permissions: ["*"] };

export const leaderRoutes = (api) => {
  const routes = defineDatabaseService(api).api.v1.filter((route) => route.id.startsWith("database.followers."));
  return async (method, pathname, body) => {
    if (!pathname.startsWith(PROXY)) return { status: 404, body: { error: `not a database route: ${pathname}` } };
    const segments = pathname.slice(PROXY.length).split("/").filter(Boolean);
    for (const route of routes) {
      if (route.method !== method) continue;
      const pattern = route.path.split("/").filter(Boolean);
      if (pattern.length !== segments.length) continue;
      const params = {};
      if (!pattern.every((part, at) => part.startsWith(":") ? ((params[part.slice(1)] = decodeURIComponent(segments[at])), true) : part === segments[at])) continue;
      const response = await route.handler({ service: api, params, query: new URLSearchParams(), body, principal: OPERATOR, headers: {}, request: undefined });
      return { status: response.status ?? 200, body: response.body };
    }
    return { status: 404, body: { error: `no follower route ${method} ${pathname}` } };
  };
};

/** A `fetch` answering the follower routes in this process, for `createZelavisClient`. */
export const leaderFetch = (api) => {
  const answer = leaderRoutes(api);
  return async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const { status, body: reply } = await answer(init?.method ?? "GET", url.pathname, body);
    return new Response(JSON.stringify(reply), { status, headers: { "content-type": "application/json" } });
  };
};
