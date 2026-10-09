import { Effect } from "effect";
import type { ZelavisServerRoute } from "../core/index.js";
import { integration, present } from "../core/runtime/effect-boundary.js";
import type { ZelavisHostOperationTrustStore } from "../core/deployment/index.js";
import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "../system-store.js";
import { enrollmentAuditEntry, listEnrollmentAudit, recordEnrollmentAttempt } from "./node-enrollment-audit.js";
import {
  NodeEnrollmentError,
  createNodeEnrollmentAuthority,
  nodeCompatibility,
} from "./node-enrollment.js";

/**
 * HTTP for node enrollment: `/runtime/nodes`.
 *
 * Design: `.agents/references/node-enrollment-design.md`. The enroll route is
 * authenticated by its single-use token alone, so it has no access requirement
 * and defends itself: bounded input, a global attempt limit, one opaque refusal.
 * The other routes need explicit permissions.
 *
 * Nodes are accepted only while the Platform has published its public trust
 * keys (`publishAgentTrust`, done by a host that can dispatch to remote
 * Agents). Without them a token could be issued that no machine could use.
 */

export const AGENT_TRUST_NAMESPACE = "fabric.agent-trust.v1";
const TRUST_KEY = "platform";
export const ENROLLMENT_ENDPOINT_NAMESPACE = "fabric.enrollment-endpoint.v1";
const ENDPOINT_KEY = "platform";
const PLACEMENT_NAMESPACE = "fabric.project-ownership.v1";
/** Attempts, not successes: a resource bound, since the tokens are unguessable. */
const ENROLL_ATTEMPTS_PER_WINDOW = 120;
const ENROLL_WINDOW_MS = 60_000;
const MAX_TTL_MINUTES = 24 * 60;

/** The Platform's public keys, which a machine needs to verify what the Platform signs. */
export const publishAgentTrust = (store: ZelavisSystemStore, trust: ZelavisHostOperationTrustStore) =>
  integration(() => store.set(AGENT_TRUST_NAMESPACE, TRUST_KEY, trust as unknown as ZelavisSystemStoreValue));

/**
 * Where a machine reaches this Platform to enroll, and the certificate fingerprint to pin.
 * Published by the host that runs the enrollment listener; public information.
 */
export interface EnrollmentEndpoint {
  readonly url: string;
  /** SHA-256 of the listener's certificate, lowercase hex. */
  readonly fingerprint: string;
}

export const publishEnrollmentEndpoint = (store: ZelavisSystemStore, endpoint: EnrollmentEndpoint) =>
  integration(() => store.set(ENROLLMENT_ENDPOINT_NAMESPACE, ENDPOINT_KEY, { url: endpoint.url, fingerprint: endpoint.fingerprint }));

const readEnrollmentEndpoint = (store: ZelavisSystemStore) =>
  integration(() => store.get(ENROLLMENT_ENDPOINT_NAMESPACE, ENDPOINT_KEY)).pipe(
    Effect.map((record): EnrollmentEndpoint | undefined => {
      const value: unknown = record?.value;
      return isObject(value) && typeof value.url === "string" && typeof value.fingerprint === "string" && /^[0-9a-f]{64}$/.test(value.fingerprint)
        ? { url: value.url, fingerprint: value.fingerprint } : undefined;
    }),
  );

const readAgentTrust = (store: ZelavisSystemStore) =>
  integration(() => store.get(AGENT_TRUST_NAMESPACE, TRUST_KEY)).pipe(
    Effect.map((record) => {
      const value: unknown = record?.value;
      const keys = typeof value === "object" && value !== null ? (value as { keys?: unknown }).keys : undefined;
      return Array.isArray(keys) && keys.length > 0 ? (value as ZelavisHostOperationTrustStore) : undefined;
    }),
  );

/** A fixed-window counter: simple, bounded and clock-injectable. */
function createAttemptLimiter(options: { readonly limit: number; readonly windowMs: number; readonly now: () => number }) {
  let windowStart = options.now();
  let used = 0;
  return () => {
    const at = options.now();
    if (at - windowStart >= options.windowMs) {
      windowStart = at;
      used = 0;
    }
    if (used >= options.limit) return false;
    used++;
    return true;
  };
}

const isObject = (value: unknown): value is { readonly [key: string]: unknown } =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const noStore = { "cache-control": "no-store" } as const;
const bad = (message: string) => ({ status: 400, body: { error: message } });

/** Domain failures become HTTP answers; anything else is a real fault and propagates. */
function answerFor(error: NodeEnrollmentError) {
  switch (error.code) {
    case "refused": return { status: 403, headers: noStore, body: { error: "Enrollment refused." } };
    case "invalid-request": return { status: 400, headers: noStore, body: { error: error.message } };
    case "worker-newer": return { status: 409, headers: noStore, body: { error: error.message, code: "worker-newer" } };
    case "node-exists": return { status: 409, headers: noStore, body: { error: error.message, code: "node-exists" } };
    case "enrollment-pending": return { status: 409, headers: noStore, body: { error: error.message, code: "enrollment-pending" } };
    case "contention": return { status: 503, headers: { ...noStore, "retry-after": "1" }, body: { error: error.message } };
  }
}

export function createNodeRoutes(options: {
  readonly store?: ZelavisSystemStore;
  readonly now?: () => number;
  /** This Platform's version: workers newer than it are refused, older ones are flagged. */
  readonly platformVersion?: string;
}): readonly ZelavisServerRoute<any>[] {
  const { store } = options;
  const now = options.now ?? (() => Date.now());
  const unavailable = { status: 503, body: { error: "System Store is unavailable." } };
  const notAccepting = { status: 409, headers: noStore, body: { error: "This installation does not accept nodes.", code: "nodes-disabled" } };
  const authority = store ? createNodeEnrollmentAuthority({ store, now, ...(options.platformVersion === undefined ? {} : { platformVersion: options.platformVersion }) }) : undefined;
  const admit = createAttemptLimiter({ limit: ENROLL_ATTEMPTS_PER_WINDOW, windowMs: ENROLL_WINDOW_MS, now });
  // Its own budget: reading public keys must never use up the attempts enrollment needs.
  const admitTrust = createAttemptLimiter({ limit: ENROLL_ATTEMPTS_PER_WINDOW, windowMs: ENROLL_WINDOW_MS, now });
  const system = { type: "system" as const };

  return [
    {
      id: "runtime.nodes.list", method: "GET", path: "/nodes",
      access: { permissions: ["server.nodes.view"], scope: system },
      spec: { operationId: "listNodes", summary: "List enrolled nodes and pending enrollments", tags: ["nodes"],
        responses: { 200: { description: "Nodes and enrollments, without credentials" } } },
      handler: () => present(Effect.gen(function* () {
        if (!authority) return unavailable;
        const nodes = (yield* authority.nodes()).map(({ caPem: _certificate, v: _version, ...node }) =>
          ({ ...node, compatibility: nodeCompatibility(options.platformVersion, node.version) }));
        return { headers: noStore, body: { nodes, enrollments: yield* authority.enrollments() } };
      })),
    },
    {
      id: "runtime.nodes.platform", method: "GET", path: "/nodes/platform",
      access: { permissions: ["server.nodes.view"], scope: system },
      spec: { operationId: "getNodeEnrollmentEndpoint", summary: "Where machines enroll, and the certificate fingerprint to pin", tags: ["nodes"],
        responses: { 200: { description: "The enrollment URL and fingerprint, or null when this installation serves none" } } },
      handler: () => present(Effect.gen(function* () {
        if (!store) return unavailable;
        return { headers: noStore, body: { endpoint: (yield* readEnrollmentEndpoint(store)) ?? null } };
      })),
    },
    {
      id: "runtime.nodes.enrollments.create", method: "POST", path: "/nodes/enrollments",
      access: { permissions: ["server.nodes.enroll"], scope: system },
      spec: { operationId: "createNodeEnrollment", summary: "Issue a single-use credential for a machine to join", tags: ["nodes"],
        responses: { 201: { description: "The credential, shown once" }, 400: { description: "Invalid request" },
          409: { description: "Already registered or pending, or this installation does not accept nodes" } } },
      handler: ({ body }) => present(Effect.gen(function* () {
        if (!authority || !store) return unavailable;
        if (!isObject(body) || typeof body.nodeId !== "string") return bad("A nodeId is required.");
        const ttlMinutes = body.ttlMinutes;
        if (ttlMinutes !== undefined && (typeof ttlMinutes !== "number" || !Number.isInteger(ttlMinutes) ||
            ttlMinutes < 1 || ttlMinutes > MAX_TTL_MINUTES)) {
          return bad(`ttlMinutes must be a whole number from 1 to ${MAX_TTL_MINUTES}.`);
        }
        if (body.replace !== undefined && typeof body.replace !== "boolean") return bad("replace must be a boolean.");
        if ((yield* readAgentTrust(store)) === undefined) return notAccepting;
        return yield* authority.mint({
          nodeId: body.nodeId, origin: "operator",
          ...(ttlMinutes === undefined ? {} : { ttlMs: ttlMinutes * 60_000 }),
          ...(body.replace === true ? { replace: true } : {}),
        }).pipe(
          Effect.map((minted) => ({ status: 201, headers: noStore, body: minted })),
          Effect.catchTag("NodeEnrollmentError", (error) => Effect.succeed(answerFor(error))),
        );
      })),
    },
    {
      id: "runtime.nodes.enroll", method: "POST", path: "/nodes/enroll",
      // No access requirement: the single-use token is the credential.
      spec: { operationId: "enrollNode", summary: "A machine presents its token and certificate to join", tags: ["nodes"],
        responses: { 200: { description: "The node id, Agent id and the Platform's public trust keys" },
          400: { description: "Malformed request" }, 403: { description: "Refused" },
          409: { description: "This installation does not accept nodes" }, 429: { description: "Too many attempts" } } },
      handler: ({ body }) => present(Effect.gen(function* () {
        if (!authority || !store) return unavailable;
        const trust = yield* readAgentTrust(store);
        if (trust === undefined) return notAccepting;
        if (!admit()) return { status: 429, headers: { ...noStore, "retry-after": "60" }, body: { error: "Too many enrollment attempts." } };
        if (!isObject(body) || typeof body.nodeId !== "string" || typeof body.token !== "string" ||
            typeof body.certPem !== "string" || typeof body.url !== "string" || typeof body.version !== "string") {
          return bad("nodeId, token, certPem, url and version are required.");
        }
        // The peer address is not known here (a proxy may sit in front, and a
        // forwarded header is caller-controlled), so no source binding is applied.
        // A trail that cannot be written must not undo an enrollment that already consumed its
        // token, so a failed write is reported to the log and the answer still goes out.
        const record = (error?: NodeEnrollmentError) => {
          const entry = enrollmentAuditEntry({ at: now(), nodeId: body.nodeId, version: body.version, ...(error ? { error } : {}) });
          return entry === undefined ? Effect.void
            : recordEnrollmentAttempt(store, entry).pipe(Effect.catch((failure) => Effect.logError("Enrollment audit entry could not be written", failure)));
        };
        return yield* authority.complete({ nodeId: body.nodeId, token: body.token, certPem: body.certPem, url: body.url, version: body.version }).pipe(
          Effect.tap(() => record()),
          Effect.map(({ node }) => ({ status: 200, headers: noStore, body: { nodeId: node.nodeId, agentId: node.agentId, trust } })),
          Effect.catchTag("NodeEnrollmentError", (error) => record(error).pipe(Effect.as(answerFor(error)))),
        );
      })),
    },
    {
      id: "runtime.nodes.trust", method: "POST", path: "/nodes/trust",
      // No access requirement: these are the Platform's public keys, which a joined machine
      // reads over the same pinned connection it enrolled on. POST only to keep the narrow
      // enrollment ingress to one method.
      spec: { operationId: "getAgentTrust", summary: "The Platform's current public keys, for a joined machine to refresh", tags: ["nodes"],
        responses: { 200: { description: "The trust store" }, 409: { description: "This installation does not accept nodes" },
          429: { description: "Too many requests" } } },
      handler: () => present(Effect.gen(function* () {
        if (!store) return unavailable;
        const trust = yield* readAgentTrust(store);
        if (trust === undefined) return notAccepting;
        if (!admitTrust()) return { status: 429, headers: { ...noStore, "retry-after": "60" }, body: { error: "Too many requests." } };
        return { headers: noStore, body: { trust } };
      })),
    },
    {
      id: "runtime.nodes.audit", method: "GET", path: "/nodes/audit",
      access: { permissions: ["server.nodes.manage"], scope: system },
      spec: { operationId: "getNodeEnrollmentAudit", summary: "Recent enrollment attempts and why refused ones were refused", tags: ["nodes"],
        responses: { 200: { description: "Newest first; never a token, certificate or address" } } },
      handler: () => present(Effect.gen(function* () {
        if (!store) return unavailable;
        const entries = yield* listEnrollmentAudit(store, 100);
        return { headers: noStore, body: { entries } };
      })),
    },
    {
      id: "runtime.nodes.remove", method: "DELETE", path: "/nodes/:id",
      access: { permissions: ["server.nodes.manage"], scope: system },
      spec: { operationId: "removeNode", summary: "Revoke a node so no Project is placed on it", tags: ["nodes"],
        responses: { 200: { description: "Revoked" }, 404: { description: "No such node" },
          409: { description: "Projects are still placed on this node" } } },
      handler: ({ params }) => present(Effect.gen(function* () {
        if (!authority || !store) return unavailable;
        const nodeId = params.id ?? "";
        const placements = yield* integration(() => store.list(PLACEMENT_NAMESPACE));
        const holding = placements.flatMap((record) => {
          const value: unknown = record.value;
          return isObject(value) && value.nodeId === nodeId && value.state === "active" && typeof value.projectId === "string"
            ? [value.projectId] : [];
        });
        if (holding.length > 0) {
          return { status: 409, headers: noStore, body: { error: "Projects are still placed on this node.", code: "node-in-use", projects: holding.slice(0, 20) } };
        }
        return yield* authority.revoke(nodeId).pipe(
          Effect.map(() => ({ headers: noStore, body: { removed: true } })),
          Effect.catchTag("NodeEnrollmentError", (error) =>
            Effect.succeed(error.code === "refused" ? { status: 404, headers: noStore, body: { error: "No such node." } } : answerFor(error))),
        );
      })),
    },
  ];
}
