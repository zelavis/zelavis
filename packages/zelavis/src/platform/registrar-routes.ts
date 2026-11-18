import { Effect, Schema } from "effect";
import type { ZelavisRouteResponse, ZelavisServerRoute } from "../core/index.js";
import { evaluate, integration, present, unwrapFailure } from "../core/runtime/effect-boundary.js";
import { ConnectRegistrarSchema, SetRegistrarContactSchema, RegistrarAvailabilitySchema, RegistrarQuoteSchema, RegistrarOrderInputSchema, RegistrarNameserversSchema, RegistrarError, REGISTRAR_STATUSES, type RegistrarController } from "../edge/registrar.js";
const headers = { "cache-control": "no-store" };
const response = (status: number, body?: unknown): ZelavisRouteResponse => ({ status, headers, ...(body === undefined ? {} : { body }) });
const access = (purchase: boolean) => ({ permissions: [purchase ? "server.domains.purchase" : "server.domains.view"], scope: { type: "system" as const } });
const strict = { onExcessProperty: "error" } as const;
const input = <A>(schema: Schema.Codec<A, unknown>, raw: unknown) => evaluate(() => Schema.decodeUnknownSync(schema, strict)(raw)).pipe(Effect.mapError(() => new RegistrarError({ code: "invalid_registrar_request", message: "Supply valid registrar fields." })));
const run = (program: Effect.Effect<ZelavisRouteResponse, unknown>, audit?: { readonly actor?: string; readonly action: string }) => present(Effect.gen(function* () {
  const result = yield* Effect.result(program);
  if (audit) yield* Effect.logInfo("registrar.operation", { ...audit, outcome: result._tag === "Success" ? "ok" : "failed" });
  if (result._tag === "Success") return result.success;
  const error = unwrapFailure(result.failure);
  if (error instanceof RegistrarError) return response(REGISTRAR_STATUSES[error.code], { code: error.code, error: error.message, ...(error.price ? { price: error.price } : {}) });
  yield* Effect.logWarning("registrar.operation-failed");
  return response(502, { code: "registrar_failed", error: "The registrar operation failed. Check the registrar account before trying again." });
}));

/** Platform-only, system-scoped registrar operations. Never mounted in a Project runtime. */
export function registrarRoutes(registrar: RegistrarController): readonly ZelavisServerRoute[] {
  const route = (id: string, method: "GET" | "PUT" | "POST" | "DELETE", path: string, purchase: boolean, summary: string, handler: ZelavisServerRoute["handler"]): ZelavisServerRoute => ({
    id: `runtime.registrar.${id}`, method, path: `/registrar${path}`, access: access(purchase),
    ...(method === "POST" || method === "PUT" ? { maxRequestBodyBytes: 16_384, invalidJsonBodyCode: "invalid_registrar_request" } : method === "DELETE" ? { maxRequestBodyBytes: 0 } : {}),
    spec: { operationId: `registrar.${id}`, summary, tags: ["registrar"], responses: { 200: { description: "Registrar result" }, 201: { description: "New order" }, 204: { description: "Disconnected or updated" }, 400: { description: "Invalid fields" }, 403: { description: "System permission required" }, 404: { description: "Order not found" }, 409: { description: "Price changed or domain unavailable" }, 429: { description: "Registrar busy" }, 502: { description: "Registrar failed" }, 503: { description: "Registrar unavailable" } } }, handler,
  });
  return [
    route("providers", "GET", "/providers", false, "List built-in and plugin registrars", () => run(integration(() => registrar.providers()).pipe(Effect.map(body => response(200, body))))),
    route("connection", "GET", "/connection", true, "Read connection status without credentials", () => run(integration(() => registrar.connection()).pipe(Effect.map(body => response(200, body))))),
    route("connect", "PUT", "/connection", true, "Verify and encrypt registrar account credentials", ({ body, principal }) => run(Effect.gen(function* () { const fields = yield* input(ConnectRegistrarSchema, body); return response(200, yield* integration(() => registrar.connect(fields))); }), { actor: principal?.id, action: "connect" })),
    route("disconnect", "DELETE", "/connection", true, "Disconnect the registrar after all active orders settle", ({ principal }) => run(integration(() => registrar.disconnect()).pipe(Effect.map(() => response(204))), { actor: principal?.id, action: "disconnect" })),
    route("contact", "GET", "/contact", true, "Read the private registrant contact and revision", () => run(integration(() => registrar.contact()).pipe(Effect.map(body => response(200, body))))),
    route("set-contact", "PUT", "/contact", true, "Encrypt the default registrant contact", ({ body, principal }) => run(Effect.gen(function* () { const fields = yield* input(SetRegistrarContactSchema, body); return response(200, yield* integration(() => registrar.setContact(fields))); }), { actor: principal?.id, action: "set-contact" })),
    route("availability", "POST", "/availability", true, "Check up to 20 domains and their one-year registration price", ({ body, principal }) => run(Effect.gen(function* () { const fields = yield* input(RegistrarAvailabilitySchema, body); return response(200, yield* integration(() => registrar.check(fields.domains))); }), { actor: principal?.id, action: "availability" })),
    route("quote", "POST", "/quote", true, "Quote a domain, operation and duration before price confirmation", ({ body, principal }) => run(Effect.gen(function* () { const fields = yield* input(RegistrarQuoteSchema, body); return response(200, yield* integration(() => registrar.quote(fields))); }), { actor: principal?.id, action: "quote" })),
    route("order", "POST", "/orders", true, "Place an idempotent registration, transfer or renewal order", ({ body, principal }) => run(Effect.gen(function* () {
      const fields = yield* input(RegistrarOrderInputSchema, body);
      const result = yield* integration(() => registrar.order(fields, principal!.id));
      return response(result.created ? 201 : 200, result.order);
    }), { actor: principal?.id, action: "order" })),
    route("orders", "GET", "/orders", false, "Read one page of durable registrar orders", ({ query }) => run(integration(() => registrar.orders({ ...(query.has("limit") ? { limit: Number(query.get("limit")) } : {}), ...(query.has("after") ? { after: query.get("after")! } : {}) })).pipe(Effect.map(body => response(200, body))))),
    route("order-status", "GET", "/orders/:id", false, "Read a durable order", ({ params }) => run(integration(() => registrar.getOrder(params.id ?? "")).pipe(Effect.map(body => response(200, body))))),
    route("domains", "GET", "/domains", false, "Read one page of the registrar account's domains", ({ query }) => run(integration(() => registrar.domains(query.get("cursor") ?? undefined)).pipe(Effect.map(body => response(200, body))))),
    route("nameservers", "PUT", "/domains/:domain/nameservers", true, "Set 2–12 custom nameservers", ({ body, params, principal }) => run(Effect.gen(function* () { const fields = yield* input(RegistrarNameserversSchema, body); yield* integration(() => registrar.setNameservers(params.domain ?? "", fields.nameservers)); return response(204); }), { actor: principal?.id, action: "nameservers" })),
  ];
}
