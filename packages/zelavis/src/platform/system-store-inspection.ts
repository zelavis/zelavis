import { Effect } from "effect";
import type { ZelavisServerRoute } from "../core/index.js";
import { integration, present } from "../core/runtime/effect-boundary.js";
import type { ZelavisSystemStore, ZelavisSystemStoreRecord, ZelavisSystemStoreValue } from "../system-store.js";

// Inspection never exposes signing keys, session authority or provider credentials.
const sensitive = /secret|password|credential|token|private[-_]?key|master[-_]?key|api[-_]?key|encrypted|authorization[-_]?flow|authority|signing|bearer/u;
function redact(value: ZelavisSystemStoreValue): ZelavisSystemStoreValue {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, sensitive.test(key.toLowerCase()) ? "[redacted]" : redact(child)]),
  );
  return value;
}
export function inspectSystemStoreRecord(record: ZelavisSystemStoreRecord): ZelavisSystemStoreRecord {
  return { ...record, value: sensitive.test(`${record.namespace}:${record.key}`.toLowerCase()) ||
    record.namespace === "zelavis.platform.auth" && record.key.startsWith("session:")
      ? "[redacted]" : redact(record.value) };
}

/** Read-only operator inspection of the System Store; never App database routes. */
export function createSystemStoreInspectionRoutes(store?: ZelavisSystemStore): readonly ZelavisServerRoute<any>[] {
  const access = { permissions: ["server.database.inspect"], scope: { type: "system" as const } };
  return [
    {
      id: "runtime.system-store.namespaces", method: "GET", path: "/system-store/namespaces", access,
      spec: { operationId: "listSystemStoreNamespaces", summary: "List Platform backend tables", tags: ["runtime"],
        responses: { 200: { description: "Logical tables and record counts" } } },
      handler: () => present(Effect.gen(function* () {
        if (!store) return { status: 503, body: { error: "System Store is unavailable." } };
        return { body: { namespaces: yield* integration(() => store.namespaces()) } };
      })),
    },
    {
      id: "runtime.system-store.records", method: "GET", path: "/system-store/namespaces/:namespace/records", access,
      spec: { operationId: "listSystemStoreRecords", summary: "Read Platform backend records", tags: ["runtime"],
        responses: { 200: { description: "Read-only page with secrets redacted" }, 400: { description: "Invalid page" } } },
      handler: ({ params, query }) => present(Effect.gen(function* () {
        if (!store) return { status: 503, body: { error: "System Store is unavailable." } };
        const limit = query.has("limit") ? Number(query.get("limit")) : 50;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !params.namespace?.trim()) {
          return { status: 400, body: { error: "A namespace and limit from 1 to 200 are required." } };
        }
        const page = yield* integration(() => store.page(params.namespace!, {
          limit, ...(query.has("after") ? { after: query.get("after")! } : {}),
        }));
        return { body: { ...page, records: page.records.map(inspectSystemStoreRecord) } };
      })),
    },
  ];
}
