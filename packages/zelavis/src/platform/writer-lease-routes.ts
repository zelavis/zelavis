import { Effect } from "effect";
import type { ZelavisServerRoute } from "../core/index.js";
import { integration, present } from "../core/runtime/effect-boundary.js";
import { isWriterLease, type LeaseStore } from "../db/writer-lease.js";
import type { WriterLeaseAudit } from "./writer-lease-store.js";
import { verifyLeaseCapability } from "./lease-capability.js";

/**
 * HTTP for the writer-lease authority: `/runtime/writer-leases/:partition`.
 *
 * The lease record is read, created and replaced here so Project runtimes on other hosts compare-and-set against one
 * store, the Platform's, which is the only placement authority. The routes are protocol, not policy: they enforce the
 * conditions (`create` only when absent, `replace` only against the version read) and nothing about who may write the
 * partition, which is the lease's own rule (`writer-lease.ts`). Holding `database.replicate` at the system scope is
 * the caller's authority to take part; a lease holder is a Project runtime carrying such a service-account grant.
 *
 * Versions are opaque strings: the store's own token for the record read, handed back to replace exactly it.
 */
const system = { type: "system" as const };
const noStore = { "cache-control": "no-store" };
const PARTITION = /^[A-Za-z0-9._~%-]{1,512}$/;

export interface ProjectLeaseCapabilityOptions {
  /** The installation secret the capabilities are derived from (`lease-capability.ts`). */
  readonly secret: () => Promise<string>;
  /** Whether the Project still exists: deleting one ends its capability. */
  readonly projectExists: (scope: string) => Promise<boolean>;
}

export function createWriterLeaseRoutes(leases: LeaseStore, audit?: WriterLeaseAudit, capability?: ProjectLeaseCapabilityOptions): readonly ZelavisServerRoute<any>[] {
  const refuse = (error: string, status = 400) => ({ status, headers: noStore, body: { error } });

  const readCore = (partition: string | undefined) => Effect.gen(function* () {
    if (!PARTITION.test(partition ?? "")) return refuse("A partition is 1 to 512 characters.");
    const read = yield* leases.read(partition!);
    return read === undefined ? refuse("No writer lease.", 404) : { headers: noStore, body: { lease: read.lease, version: JSON.stringify(read.version) } };
  }).pipe(Effect.catchCause(() => Effect.succeed(refuse("The lease store is unavailable.", 503))));

  /** `onlyOwner` confines a write to leases that name that node: a capability can make no other node the writer. */
  const writeCore = (partition: string | undefined, body: unknown, who: string, onlyOwner?: string) => Effect.gen(function* () {
    if (!PARTITION.test(partition ?? "")) return refuse("A partition is 1 to 512 characters.");
    const input = (typeof body === "object" && body !== null ? body : {}) as { lease?: unknown; expectedVersion?: unknown };
    if (!isWriterLease(input.lease) || input.lease.partition !== partition) return refuse("The body is { lease: { partition, owner, epoch, expiresAt, acknowledgedHead }, expectedVersion? } for this partition.");
    const lease = input.lease;
    if (onlyOwner !== undefined && lease.owner !== onlyOwner) return refuse(`This credential may hold the lease only as ${onlyOwner}.`, 403);
    /** A change of writer (a new lease, or another owner or epoch) is audited after it lands; renewals are not. */
    const audited = (before: { readonly owner: string; readonly epoch: number } | undefined) => before !== undefined && before.owner === lease.owner && before.epoch === lease.epoch
      ? Effect.void
      : (audit?.record({
          at: Date.now(), principal: who, partition: lease.partition,
          ...(before === undefined ? {} : { from: before }), to: { owner: lease.owner, epoch: lease.epoch },
          ...(lease.lostPositions === undefined ? {} : { lostPositions: lease.lostPositions }),
          // The change has landed and stands; an audit that could not be written is reported, never silent.
        }) ?? Effect.void).pipe(Effect.catchCause((cause) => Effect.logError(`The change of writer of ${lease.partition} landed but its audit entry could not be written`, cause)));
    if (input.expectedVersion === undefined) {
      if (!(yield* leases.create(lease))) return refuse("A lease already exists.", 409);
      yield* audited(undefined);
      return { status: 201, headers: noStore, body: { written: true } };
    }
    if (typeof input.expectedVersion !== "string" || input.expectedVersion.length > 4096) return refuse("expectedVersion is the version a read answered.");
    const expected = input.expectedVersion;
    const parsed = yield* Effect.exit(Effect.try(() => JSON.parse(expected) as unknown));
    if (parsed._tag === "Failure") return refuse("expectedVersion is the version a read answered.");
    const version = parsed.value;
    const before = (yield* leases.read(lease.partition))?.lease;
    const replaced = yield* leases.replace({ lease, version }, lease);
    if (!replaced) return refuse("The lease changed since it was read.", 409);
    yield* audited(before === undefined ? undefined : { owner: before.owner, epoch: before.epoch });
    return { headers: noStore, body: { written: true } };
  }).pipe(Effect.catchCause(() => Effect.succeed(refuse("The lease store is unavailable.", 503))));

  /** The scope and node a request's bearer capability names, when it is authentic and its Project exists. */
  const authorize = (request: Request | undefined, scope: string | undefined) => Effect.gen(function* () {
    if (capability === undefined) return undefined;
    const header = request?.headers.get("authorization") ?? "";
    const token = /^Bearer (\S+)$/.exec(header)?.[1];
    if (token === undefined) return undefined;
    const secret = yield* integration(() => capability.secret());
    const claims = yield* integration(() => verifyLeaseCapability(secret, token));
    if (claims === undefined || claims.scope !== scope) return undefined;
    return (yield* integration(() => capability.projectExists(claims.scope))) ? claims : undefined;
  }).pipe(Effect.catchCause(() => Effect.succeed(undefined)));

  return [
    {
      id: "runtime.writerLeases.read", method: "GET", path: "/writer-leases/:partition",
      access: { permissions: ["database.replicate"], scope: system },
      spec: {
        operationId: "readWriterLease", summary: "Read a partition's writer lease", tags: ["runtime"],
        pathParams: { partition: { type: "string", required: true, description: "The Tenant, or a divided Tenant's part key" } },
        responses: { 200: { description: "{ lease, version }" }, 404: { description: "The partition has never had a writer lease" } },
      },
      handler: ({ params }) => present(readCore(params.partition)),
    },
    {
      id: "runtime.writerLeases.write", method: "PUT", path: "/writer-leases/:partition",
      access: { permissions: ["database.replicate"], scope: system },
      spec: {
        operationId: "writeWriterLease", summary: "Create or replace a partition's writer lease, conditionally", tags: ["runtime"],
        description: "Without `expectedVersion` the lease is created and the call fails with 409 if one exists. With it, the lease replaces exactly the record that version names and fails with 409 if the record has changed since. The 409 body is the refusal; a caller reads the lease again to learn who holds it.",
        pathParams: { partition: { type: "string", required: true, description: "The Tenant, or a divided Tenant's part key" } },
        requestBody: { required: true, schema: { type: "object", required: ["lease"], properties: {
          lease: { type: "object", description: "{ partition, owner, epoch, expiresAt, acknowledgedHead }" },
          expectedVersion: { type: "string", description: "The version a read answered, for a replace" },
        } } },
        responses: { 200: { description: "Replaced" }, 201: { description: "Created" }, 409: { description: "The condition failed; nothing was written" } },
      },
      handler: ({ params, body, principal }) => present(writeCore(params.partition, body, typeof principal?.id === "string" ? principal.id : "unknown")),
    },
    {
      id: "runtime.writerLeases.audit", method: "GET", path: "/writer-lease-audit",
      access: { permissions: ["database.replicate"], scope: system },
      spec: {
        operationId: "listWriterLeaseAudit", summary: "Changes of writer, newest first", tags: ["runtime"],
        description: "Every lease created or taken over: who asked, which partition, from which owner and epoch to which, and the acknowledged positions a promotion accepted losing. Renewals are not recorded. The newest 500 are kept.",
        queryParams: { limit: { type: "integer", description: "At most this many entries, 1 to 200; 50 unless given" } },
        responses: { 200: { description: "{ entries }" } },
      },
      handler: ({ query }) => present(Effect.gen(function* () {
        const asked = Number(query?.get("limit") ?? 50);
        const limit = Number.isSafeInteger(asked) ? Math.min(Math.max(asked, 1), 200) : 50;
        return { headers: noStore, body: { entries: audit === undefined ? [] : yield* audit.list(limit) } };
      }).pipe(Effect.catchCause(() => Effect.succeed(refuse("The audit trail is unavailable.", 503))))),
    },
    ...(capability === undefined ? [] : [
      {
        id: "runtime.projectLeases.read", method: "GET" as const, path: "/project-leases/:scope",
        spec: {
          operationId: "readProjectLease", summary: "Read a Project's writer lease with its lease capability", tags: ["runtime"],
          description: "For a Project runtime holding its own lease: authorized by the capability the Platform gave it at start (`Authorization: Bearer`), which names this Project and one node, and by nothing else.",
          pathParams: { scope: { type: "string" as const, required: true, description: "The Project's id" } },
          responses: { 200: { description: "{ lease, version }" }, 401: { description: "No valid capability for this Project" }, 404: { description: "No lease yet" } },
        },
        handler: ({ params, request }: { params: Record<string, string | undefined>; request?: Request }) => present(Effect.gen(function* () {
          const claims = yield* authorize(request, params.scope);
          return claims === undefined ? refuse("Not authorized for this Project's lease.", 401) : yield* readCore(params.scope);
        })),
      },
      {
        id: "runtime.projectLeases.write", method: "PUT" as const, path: "/project-leases/:scope",
        spec: {
          operationId: "writeProjectLease", summary: "Create or replace a Project's writer lease with its lease capability", tags: ["runtime"],
          description: "As `writeWriterLease`, for the node the capability names: the lease written must name that node as its owner (403 otherwise). The Project's id is the lease's scope.",
          pathParams: { scope: { type: "string" as const, required: true, description: "The Project's id" } },
          responses: { 200: { description: "Replaced" }, 201: { description: "Created" }, 401: { description: "No valid capability for this Project" }, 403: { description: "The lease names another node as owner" }, 409: { description: "The condition failed" } },
        },
        handler: ({ params, body, request }: { params: Record<string, string | undefined>; body?: unknown; request?: Request }) => present(Effect.gen(function* () {
          const claims = yield* authorize(request, params.scope);
          return claims === undefined ? refuse("Not authorized for this Project's lease.", 401)
            : yield* writeCore(params.scope, body, `project:${claims.scope}@${claims.node}`, claims.node);
        })),
      },
    ]),
  ];
}
