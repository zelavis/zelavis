import { Effect } from "effect";
import type { ZelavisServerRoute } from "../core/index.js";
import { present } from "../core/runtime/effect-boundary.js";
import { isWriterLease, type LeaseStore } from "../db/writer-lease.js";

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

export function createWriterLeaseRoutes(leases: LeaseStore): readonly ZelavisServerRoute<any>[] {
  const refuse = (error: string, status = 400) => ({ status, headers: noStore, body: { error } });
  return [
    {
      id: "runtime.writerLeases.read", method: "GET", path: "/writer-leases/:partition",
      access: { permissions: ["database.replicate"], scope: system },
      spec: {
        operationId: "readWriterLease", summary: "Read a partition's writer lease", tags: ["runtime"],
        pathParams: { partition: { type: "string", required: true, description: "The Tenant, or a divided Tenant's part key" } },
        responses: { 200: { description: "{ lease, version }" }, 404: { description: "The partition has never had a writer lease" } },
      },
      handler: ({ params }) => present(Effect.gen(function* () {
        if (!PARTITION.test(params.partition ?? "")) return refuse("A partition is 1 to 512 characters.");
        const read = yield* leases.read(params.partition!);
        return read === undefined ? refuse("No writer lease.", 404) : { headers: noStore, body: { lease: read.lease, version: JSON.stringify(read.version) } };
      }).pipe(Effect.catchCause(() => Effect.succeed(refuse("The lease store is unavailable.", 503))))),
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
      handler: ({ params, body }) => present(Effect.gen(function* () {
        if (!PARTITION.test(params.partition ?? "")) return refuse("A partition is 1 to 512 characters.");
        const input = (typeof body === "object" && body !== null ? body : {}) as { lease?: unknown; expectedVersion?: unknown };
        if (!isWriterLease(input.lease) || input.lease.partition !== params.partition) return refuse("The body is { lease: { partition, owner, epoch, expiresAt, acknowledgedHead }, expectedVersion? } for this partition.");
        if (input.expectedVersion === undefined) {
          return (yield* leases.create(input.lease)) ? { status: 201, headers: noStore, body: { written: true } } : refuse("A lease already exists.", 409);
        }
        if (typeof input.expectedVersion !== "string" || input.expectedVersion.length > 4096) return refuse("expectedVersion is the version a read answered.");
        const expected = input.expectedVersion;
        const parsed = yield* Effect.exit(Effect.try(() => JSON.parse(expected) as unknown));
        if (parsed._tag === "Failure") return refuse("expectedVersion is the version a read answered.");
        const version = parsed.value;
        const replaced = yield* leases.replace({ lease: input.lease, version }, input.lease);
        return replaced ? { headers: noStore, body: { written: true } } : refuse("The lease changed since it was read.", 409);
      }).pipe(Effect.catchCause(() => Effect.succeed(refuse("The lease store is unavailable.", 503))))),
    },
  ];
}
