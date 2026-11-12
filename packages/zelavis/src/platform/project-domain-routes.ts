import { Effect } from "effect";
import { principalHasPermission, type ZelavisRouteResponse, type ZelavisServerRoute } from "../core/index.js";
import { evaluate, integration, present, unwrapFailure } from "../core/runtime/effect-boundary.js";
import {
  decodeAddProjectDomain, decodeVerifyProjectDomain, normalizeProjectDomainHostname,
  PROJECT_DOMAINS_MANAGE, PROJECT_DOMAINS_VIEW, ProjectDomainError, type ProjectDomainController,
} from "../edge/project-domains.js";

const statuses = {
  invalid_hostname: 400, invalid_domain_request: 400, domain_not_found: 404, hostname_unavailable: 409,
  domain_revision_conflict: 409, project_deleting: 409, dns_not_verified: 422, domain_limit: 429,
  domain_verification_busy: 429, domain_ingress_unavailable: 503,
} as const;
const invalid = () => new ProjectDomainError({
  code: "invalid_domain_request", message: "Supply valid domain operation fields and a current revision when required.",
});
const headers = { "cache-control": "no-store" };
const response = (status: number, body: unknown): ZelavisRouteResponse => ({ status, headers, body });

const run = (program: Effect.Effect<ZelavisRouteResponse, Error>, audit?: {
  actor?: string; projectId: string; action: string; hostname?: string; revision?: number;
}) => present(Effect.gen(function* () {
  const result = yield* Effect.result(program);
  if (result._tag === "Success") {
    if (audit) yield* Effect.logInfo("Project domain operation", { ...audit, status: result.success.status });
    return result.success;
  }
  const error = unwrapFailure(result.failure);
  if (error instanceof ProjectDomainError) {
    if (audit) yield* Effect.logInfo("Project domain operation", { ...audit, code: error.code });
    return {
      ...response(statuses[error.code], { error: error.message, code: error.code }),
      headers: { ...headers, ...(error.retryAfter === undefined ? {} : { "retry-after": String(error.retryAfter) }) },
    };
  }
  yield* Effect.logWarning("Project domain storage or ingress operation failed", audit);
  return response(503, { error: "The Project domain operation is temporarily unavailable.", code: "domain_ingress_unavailable" });
}));

export function projectDomainRoutes(controller: ProjectDomainController): readonly ZelavisServerRoute[] {
  const path = "/projects/:projectId/domains";
  const scope = { type: "project" as const, projectIdParam: "projectId" };
  const write = { permissions: [PROJECT_DOMAINS_MANAGE], scope };
  const bodyOptions = { maxRequestBodyBytes: 1024, invalidJsonBodyCode: "invalid_domain_request" };
  return [
    {
      id: "runtime.projects.domains.list", method: "GET", path,
      spec: { operationId: "listProjectDomains", summary: "List an exact Project's domains", tags: ["projects"],
        responses: { 200: { description: "Project domains" }, 403: { description: "Missing domain permission" } } },
      access: { authenticated: true, scope },
      handler: ({ params, principal }) => {
        const projectId = params.projectId ?? "";
        const exact = { type: "project" as const, projectId };
        if (!principalHasPermission(principal, PROJECT_DOMAINS_VIEW, exact) &&
            !principalHasPermission(principal, PROJECT_DOMAINS_MANAGE, exact)) {
          return response(403, { error: "Missing required permission", code: "forbidden" });
        }
        return run(integration(() => controller.list(projectId)).pipe(Effect.map(body => response(200, body))));
      },
    },
    {
      id: "runtime.projects.domains.add", method: "POST", path, access: write, ...bodyOptions,
      spec: { operationId: "addProjectDomain", summary: "Create a DNS TXT challenge for a Project domain", tags: ["projects"],
        responses: { 201: { description: "Challenge created" }, 200: { description: "Existing domain" }, 409: { description: "Hostname unavailable" } } },
      handler: ({ params, principal, body }) => {
        const projectId = params.projectId ?? "";
        const audit = { actor: principal?.id, projectId, action: "add", hostname: undefined as string | undefined, revision: undefined as number | undefined };
        return run(Effect.gen(function* () {
          const input = yield* evaluate(() => decodeAddProjectDomain(body)).pipe(Effect.mapError(invalid));
          audit.hostname = normalizeProjectDomainHostname(input.hostname);
          const { domain, created } = yield* integration(() => controller.add(projectId, input));
          audit.revision = domain.revision;
          return response(created ? 201 : 200, domain);
        }), audit);
      },
    },
    {
      id: "runtime.projects.domains.verify", method: "POST", path: `${path}/:hostname/verify`, access: write, ...bodyOptions,
      spec: { operationId: "verifyProjectDomain", summary: "Verify a Project domain and apply its ingress", tags: ["projects"],
        responses: { 200: { description: "Active domain" }, 202: { description: "Activation pending" }, 422: { description: "TXT proof missing" } } },
      handler: ({ params, principal, body }) => {
        const projectId = params.projectId ?? "";
        const hostname = params.hostname ?? "";
        const audit = { actor: principal?.id, projectId, action: "verify", hostname: normalizeProjectDomainHostname(hostname), revision: undefined as number | undefined };
        return run(Effect.gen(function* () {
          const input = yield* evaluate(() => decodeVerifyProjectDomain(body)).pipe(Effect.mapError(invalid));
          audit.revision = input.expectedRevision;
          const domain = yield* integration(() => controller.verify(projectId, hostname, input));
          audit.revision = domain.revision;
          if (domain.issue === "edge_unavailable") return yield* new ProjectDomainError({
            code: "domain_ingress_unavailable", message: "The hostname is verified. This installation has no available ingress for the selected TLS mode.",
          });
          return response(domain.state === "active" ? 200 : 202, domain);
        }), audit);
      },
    },
    {
      id: "runtime.projects.domains.remove", method: "DELETE", path: `${path}/:hostname`, access: write, maxRequestBodyBytes: 0,
      spec: { operationId: "removeProjectDomain", summary: "Withdraw a Project domain", tags: ["projects"],
        responses: { 200: { description: "Domain withdrawn" }, 202: { description: "Withdrawal pending" }, 409: { description: "Revision conflict" } } },
      handler: ({ params, principal, query }) => {
        const projectId = params.projectId ?? "";
        const hostname = params.hostname ?? "";
        const values = query.getAll("revision");
        const raw = values[0] ?? "";
        const revision = values.length === 1 && /^\d{1,16}$/.test(raw) ? Number(raw) : NaN;
        const audit = { actor: principal?.id, projectId, action: "remove", hostname: normalizeProjectDomainHostname(hostname), revision };
        return run(Effect.gen(function* () {
          if (!Number.isSafeInteger(revision)) return yield* invalid();
          const result = yield* integration(() => controller.remove(projectId, hostname, revision));
          return response(result.pending ? 202 : 200, result);
        }), audit);
      },
    },
  ];
}
