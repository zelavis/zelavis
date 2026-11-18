import { Effect } from "effect";
import type { ZelavisRouteResponse, ZelavisServerRoute } from "../core/index.js";
import { evaluate, integration, present, unwrapFailure } from "../core/runtime/effect-boundary.js";
import type { ZelavisCertificateController } from "../edge/certificates.js";
import {
  decodeAdoptDnsZone, decodeConnectDnsProvider, EDGE_DNS_STATUSES, EdgeDnsError, type EdgeDnsController,
} from "../edge/dns-connections.js";
import type { ZelavisEdgeManager } from "../edge/index.js";
import { applyRenewedEdgeCertificates } from "../edge/production.js";
import type { ZelavisEdgeRouteStore } from "../edge/routes.js";

const headers = { "cache-control": "no-store" };
const response = (status: number, body: unknown): ZelavisRouteResponse => ({ status, headers, body });
const invalid = () => new EdgeDnsError({ code: "invalid_dns_connection", message: "Supply valid DNS fields." });
const view = { permissions: ["server.edge.view"] };
const manage = { permissions: ["server.edge.manage"] };
const bodyOptions = { maxRequestBodyBytes: 8192, invalidJsonBodyCode: "invalid_dns_connection" };

const run = (program: Effect.Effect<ZelavisRouteResponse, unknown>, audit?: { actor?: string; action: string; target?: string }) =>
  present(Effect.gen(function* () {
    const result = yield* Effect.result(program);
    if (result._tag === "Success") {
      if (audit) yield* Effect.logInfo("Edge DNS operation", { ...audit, status: result.success.status });
      return result.success;
    }
    const error = unwrapFailure(result.failure);
    if (error instanceof EdgeDnsError) {
      if (audit) yield* Effect.logInfo("Edge DNS operation", { ...audit, code: error.code });
      return response(EDGE_DNS_STATUSES[error.code], { error: error.message, code: error.code });
    }
    yield* Effect.logWarning("Edge DNS operation failed", { ...audit, error: error instanceof Error ? error.message : String(error) });
    return response(502, { error: error instanceof Error ? error.message : "The DNS operation failed.", code: "dns_provider_failed" });
  }));

/** `/runtime/edge/dns/*`: operator DNS connections, adopted zones and wildcard certificates. Platform Edge authority. */
export function edgeDnsRoutes(dns: EdgeDnsController, options: {
  readonly certificates?: ZelavisCertificateController;
  readonly routes?: ZelavisEdgeRouteStore;
  readonly manager?: ZelavisEdgeManager;
}): readonly ZelavisServerRoute[] {
  const spec = (operationId: string, summary: string, responses: Record<number, string>) => ({
    operationId, summary, tags: ["edge"],
    responses: Object.fromEntries(Object.entries(responses).map(([status, description]) => [status, { description }])),
  });
  return [
    {
      id: "runtime.edge.dns.providers", method: "GET", path: "/edge/dns/providers", access: view,
      spec: spec("listEdgeDnsProviders", "List DNS providers, built-in and from plugins, and whether each is connected", { 200: "Providers" }),
      handler: () => run(integration(() => dns.providers()).pipe(Effect.map(body => response(200, body)))),
    },
    {
      id: "runtime.edge.dns.connect", method: "PUT", path: "/edge/dns/connections/:provider", access: manage, ...bodyOptions,
      spec: spec("connectEdgeDnsProvider", "Store a DNS provider's credentials, encrypted, after checking them with the provider",
        { 200: "Connected", 400: "Invalid credentials", 409: "Revision conflict", 502: "The provider refused", 503: "Provider not installed" }),
      handler: ({ params, body, principal }) => {
        const provider = params.provider ?? "";
        return run(Effect.gen(function* () {
          const input = yield* evaluate(() => decodeConnectDnsProvider(body)).pipe(Effect.mapError(invalid));
          return response(200, yield* integration(() => dns.connect(provider, input)));
        }), { actor: principal?.id, action: "connect", target: provider });
      },
    },
    {
      id: "runtime.edge.dns.disconnect", method: "DELETE", path: "/edge/dns/connections/:provider", access: manage, maxRequestBodyBytes: 0,
      spec: spec("disconnectEdgeDnsProvider", "Delete a DNS provider connection", { 204: "Disconnected", 409: "A zone uses it" }),
      handler: ({ params, principal }) => run(integration(() => dns.disconnect(params.provider ?? "")).pipe(
        Effect.map(() => ({ status: 204, headers }))), { actor: principal?.id, action: "disconnect", target: params.provider }),
    },
    {
      id: "runtime.edge.dns.provider-zones", method: "GET", path: "/edge/dns/connections/:provider/zones", access: manage,
      spec: spec("listEdgeDnsProviderZones", "List one page of a connected provider's zones", { 200: "Zones", 502: "The provider refused" }),
      handler: ({ params, query }) => run(integration(() => dns.providerZones(params.provider ?? "", query.get("cursor") ?? undefined))
        .pipe(Effect.map(body => response(200, body)))),
    },
    {
      id: "runtime.edge.dns.zones", method: "GET", path: "/edge/dns/zones", access: view,
      spec: spec("listEdgeDnsZones", "List adopted DNS zones", { 200: "Adopted zones" }),
      handler: () => run(integration(() => dns.zones()).pipe(Effect.map(body => response(200, body)))),
    },
    {
      id: "runtime.edge.dns.adopt-zone", method: "PUT", path: "/edge/dns/zones/:apex", access: manage, ...bodyOptions,
      spec: spec("adoptEdgeDnsZone", "Adopt or update a zone: its provider zone, hosted subdomains and their address targets",
        { 200: "Adopted", 400: "Invalid zone", 404: "Provider zone not found", 409: "Revision conflict", 429: "Zone limit" }),
      handler: ({ params, body, principal }) => run(Effect.gen(function* () {
        const input = yield* evaluate(() => decodeAdoptDnsZone(body)).pipe(Effect.mapError(invalid));
        return response(200, yield* integration(() => dns.adoptZone(params.apex ?? "", input)));
      }), { actor: principal?.id, action: "adopt-zone", target: params.apex }),
    },
    {
      id: "runtime.edge.dns.release-zone", method: "DELETE", path: "/edge/dns/zones/:apex", access: manage, maxRequestBodyBytes: 0,
      spec: spec("releaseEdgeDnsZone", "Release an adopted zone", { 204: "Released", 404: "Not adopted", 409: "Project domains use it" }),
      handler: ({ params, principal }) => run(integration(() => dns.releaseZone(params.apex ?? "")).pipe(
        Effect.map(() => ({ status: 204, headers }))), { actor: principal?.id, action: "release-zone", target: params.apex }),
    },
    {
      id: "runtime.edge.dns.wildcard", method: "POST", path: "/edge/dns/zones/:apex/wildcard-certificate", access: manage, maxRequestBodyBytes: 0,
      spec: spec("orderEdgeDnsWildcardCertificate", "Order (or renew) the zone's wildcard certificate through ACME DNS-01",
        { 200: "Certificate", 404: "Not adopted", 502: "Issuance failed", 503: "Certificate management unavailable" }),
      handler: ({ params, principal }) => run(Effect.gen(function* () {
        const certificates = options.certificates;
        if (!certificates) return response(503, { error: "Certificate management is unavailable.", code: "dns_provider_unavailable" });
        const zone = yield* integration(() => dns.zone(params.apex ?? ""));
        if (!zone) return yield* new EdgeDnsError({ code: "dns_zone_not_found", message: "The zone is not adopted." });
        const certificate = yield* integration(() => certificates.orderCertificate({
          hostname: `*.${zone.apex}`, challenge: "dns-01", forceRenew: true, signal: AbortSignal.timeout(300_000),
        }));
        yield* dns.access.setWildcardCertificate(zone.apex, certificate.ref);
        yield* applyRenewedEdgeCertificates({ routes: options.routes, manager: options.manager, renewed: [certificate.ref] });
        return response(200, { certificate });
      }), { actor: principal?.id, action: "wildcard-certificate", target: params.apex }),
    },
  ];
}
