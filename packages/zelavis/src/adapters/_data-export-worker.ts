/**
 * Exports a stopped database under the source release's own Node and Effect runtime. Layout 2 reads its backup;
 * layout 4 reads each partition's full log when intact and uses the backup for compacted partitions.
 * App-wide data is read from the global handle. Index definitions are exported separately from derived entries.
 *
 * Each NDJSON file has one header and one line per event. The export is checked against the earlier engine's reads.
 * Exit 0 writes the manifest last; a refusal leaves no manifest for the migration to use.
 */
import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { arrayOf, isBoolean, isRecord, isSafeInteger, isString, isUnknown, objectFields, optional, parseJson, type JsonValidator } from "../core/json-validation.js";
import { evaluate, integration } from "../core/runtime/effect-boundary.js";
import { crossTenantIndexDefinitionOf, isCrossTenantIndexDefinition } from "../db/cross-tenant-index.js";
import { isReservedTenantId } from "../db/naming.js";
import { GLOBAL_SHARD, GLOBAL_TENANT, TOPOLOGY_SHARD } from "../db/topology.js";
import {
  comparableDocument, DATA_EXPORT_FORMAT, EXPORT_EVENT_CAP, exportedDocument, exportedEvent,
  isLayout4DurableRecord, placementClasses, sourceNamesOf, type ExportedEvent, type ExportManifest, type TenantHistory,
} from "./_data-export-format.js";

interface EarlierTenant {
  readonly backups: { readonly exportTenant: unknown };
  readonly documents: {
    readonly listCollections: unknown;
    readonly findPage: (input: { readonly collection: string; readonly limit: number; readonly after?: unknown }) => unknown;
  };
}

interface EarlierEngine {
  readonly database: {
    readonly tenants: unknown;
    readonly shardOf: (tenant: string) => string;
    readonly maintenance: { readonly status: unknown };
    readonly followers: { readonly source: (partition: string) => unknown };
    readonly forTenant: (tenant: string) => EarlierTenant;
    readonly global?: EarlierTenant;
    readonly crossTenantIndexes?: { readonly list: unknown };
    readonly topology?: {
      readonly placement: { readonly current: () => { readonly collections: unknown } };
      readonly subdivision: { readonly current: () => { readonly tenants: Readonly<Record<string, unknown>> } };
    };
  };
  readonly close: () => Promise<void>;
}

/** What the earlier engine answers, checked before it is relied on: its values cross from another release's code. */
const shardStatus = arrayOf(objectFields<{ readonly shard: string; readonly compactedTo: number }>({ shard: isString, compactedTo: isSafeInteger }));
const partitionStatus = arrayOf(objectFields<{ readonly partition: string; readonly shard: string; readonly compactedTo: number }>({
  partition: isString, shard: isString, compactedTo: isSafeInteger,
}));
const leaderStats = objectFields<{
  readonly head: number; readonly compactedTo: number; readonly seeding?: boolean; readonly lineage?: ReadonlyArray<unknown>;
}>({
  head: isSafeInteger, compactedTo: isSafeInteger, seeding: optional(isBoolean), lineage: optional(arrayOf(isUnknown)),
});
interface EarlierLeaderSource {
  readonly stats: unknown;
  readonly events: { readonly read: (options: { readonly after?: string; readonly limit: number }) => unknown };
}
const tenantBackup = objectFields<{ readonly events: ReadonlyArray<unknown> }>({ events: Array.isArray as JsonValidator<ReadonlyArray<unknown>> });
const collectionNames = arrayOf(objectFields<{ readonly name: string }>({ name: isString }));
const documentPage = objectFields<{ readonly documents: ReadonlyArray<unknown>; readonly next: unknown }>({
  documents: Array.isArray as JsonValidator<ReadonlyArray<unknown>>, next: isUnknown,
});

/** Documents read back from the earlier engine per request, and event lines written per chunk. */
const PAGE = 1000;

const option = (name: string) => evaluate(() => {
  const at = process.argv.indexOf(`--${name}`);
  const value = at < 0 ? undefined : process.argv[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing --${name}.`);
  return value;
});

const refuse = (message: string) => evaluate((): never => { throw new Error(`REFUSED ${message}`); });
const answered = <A>(value: unknown, check: JsonValidator<A>, what: string) =>
  evaluate(() => { if (!check(value)) throw new Error(`The earlier engine answered ${what} in a shape this export cannot read.`); return value; });

const program = Effect.gen(function* () {
  const platform = yield* option("platform"), shards = yield* option("shards"), out = yield* option("out");
  const sourceFormat = Number(yield* option("source-format"));
  const layout = sourceNamesOf(sourceFormat);
  if (layout === undefined) return yield* refuse(`Unknown source layout ${sourceFormat}.`);
  const earlier = yield* integration(() => import(pathToFileURL(join(platform, "dist", "db", "node-host.js")).href) as Promise<{ openNodeDatabase: (options: { directory: string; crossTenantRefresh?: false }) => Promise<EarlierEngine> }>);
  const earlierEffect = yield* integration(() => import(pathToFileURL(join(platform, "node_modules", "effect", "dist", "index.js")).href) as Promise<{
    Effect: { runPromise: (program: unknown) => Promise<unknown> };
    Stream: { runCollect: (stream: unknown) => unknown };
  }>);
  const run = (earlierProgram: unknown) => integration(() => earlierEffect.Effect.runPromise(earlierProgram));
  const opened = yield* integration(() => earlier.openNodeDatabase({ directory: shards, ...(sourceFormat === 4 ? { crossTenantRefresh: false } : {}) }));

  /**
   * The export's final state against the earlier engine's own reads: the same collections, and in each the same
   * documents. The first difference refuses.
   */
  const matchesEarlierEngine = (tenant: string, handle: EarlierTenant, events: ReadonlyArray<ExportedEvent>) => Effect.gen(function* () {
    const incomplete = (what: string) => refuse(`Tenant "${tenant}": its export does not match the earlier engine's own ${what}; the export is incomplete. Nothing was changed.`);
    const live = new Map<number, ExportedEvent>();
    for (const event of events) {
      if (event.kind === "retract") live.delete(event.seq);
      else live.set(event.seq, event);
    }
    const collectionNamespace = layout.collectionNamespace(tenant), documentPrefix = layout.documentPrefix(tenant);
    const names = new Set<string>();
    const expected = new Map<string, Map<string, { readonly comparable: string; readonly timed: boolean }>>();
    for (const event of live.values()) {
      const namespace = event.identity?.namespace;
      if (namespace === undefined) continue;
      if (namespace === collectionNamespace) names.add(event.identity!.key);
      if (!namespace.startsWith(documentPrefix)) continue;
      const stored = yield* evaluate(() => parseJson(Buffer.from(event.body ?? "", "base64").toString("utf8"), exportedDocument, `Exported document of Tenant "${tenant}"`));
      const timed = stored.createdAt !== undefined && stored.updatedAt !== undefined;
      const collection = namespace.slice(documentPrefix.length);
      const documents = expected.get(collection) ?? new Map<string, { readonly comparable: string; readonly timed: boolean }>();
      documents.set(event.identity!.key, { comparable: comparableDocument({ ...stored, version: stored.version ?? 1 }, timed), timed });
      expected.set(collection, documents);
    }

    const { documents } = handle;
    const listed = yield* answered(yield* run(documents.listCollections), collectionNames, "its collections");
    for (const { name } of listed) if (!names.has(name)) return yield* incomplete(`collections (${name})`);
    if (listed.length !== names.size) {
      const missing = [...names].find((name) => !listed.some((collection) => collection.name === name));
      return yield* incomplete(`collections (${missing})`);
    }
    for (const name of names) {
      const wanted = expected.get(name) ?? new Map<string, { readonly comparable: string; readonly timed: boolean }>();
      let read = 0;
      let after: unknown;
      for (;;) {
        const page = yield* answered(
          yield* run(documents.findPage({ collection: name, limit: PAGE, ...(after === undefined ? {} : { after }) })),
          documentPage, `a page of "${name}"`);
        for (const held of page.documents) {
          const document = yield* answered(held, exportedDocument, `a document of "${name}"`);
          const exported = wanted.get(document.id);
          if (exported === undefined || exported.comparable !== comparableDocument({ ...document, version: document.version ?? 1 }, exported.timed)) {
            return yield* incomplete(`documents (${name}/${document.id})`);
          }
          read += 1;
        }
        if (page.next === undefined) break;
        after = page.next;
      }
      if (read !== wanted.size) return yield* incomplete(`documents (${name}: ${wanted.size} exported, ${read} read back)`);
    }
  });

  const historyOf = (tenant: string, source: EarlierLeaderSource, head: number) => Effect.gen(function* () {
    const events: ExportedEvent[] = [];
    let after: string | undefined;
    let read = 0;
    while (read < head) {
      const page = yield* answered(yield* run(earlierEffect.Stream.runCollect(source.events.read({
        ...(after === undefined ? {} : { after }), limit: PAGE,
      }))), arrayOf(isRecord), `a log page of Tenant "${tenant}"`);
      if (page.length === 0 || page.length > PAGE || read + page.length > head) {
        return yield* refuse(`Tenant "${tenant}" has an incomplete or inconsistent log export.`);
      }
      for (const raw of page) {
        const { _tag, seq, version, at, identity, bytes, cursor, manifest } = raw;
        if (!isString(cursor) || cursor === after || (_tag !== "ObjectPut" && _tag !== "ObjectRetracted")) {
          return yield* refuse(`Tenant "${tenant}" has an unreadable log event.`);
        }
        after = cursor;
        if (identity === undefined) continue;
        const durable = isRecord(identity) && isString(identity.namespace) && isLayout4DurableRecord(identity.namespace);
        const event = _tag === "ObjectPut" && bytes instanceof Uint8Array
          ? { kind: "put", seq, version, at, identity, body: Buffer.from(bytes).toString("base64"), ...(durable ? { manifest } : {}) }
          : { kind: _tag === "ObjectRetracted" ? "retract" : undefined, seq, version, at, identity };
        if (!exportedEvent(event)) return yield* refuse(`Tenant "${tenant}" has an unreadable log record.`);
        events.push(event);
      }
      read += page.length;
    }
    return events;
  });

  const backupOf = (tenant: string, handle: EarlierTenant) => Effect.gen(function* () {
    const backup = yield* answered(yield* run(handle.backups.exportTenant), tenantBackup, `the export of Tenant "${tenant}"`);
    if (backup.events.length >= EXPORT_EVENT_CAP) {
      return yield* refuse(`Tenant "${tenant}" exported ${backup.events.length} events, which reaches the migration's export cap.`);
    }
    const events: ExportedEvent[] = [];
    for (const raw of backup.events) {
      const { kind, seq, version, at, identity, body, manifest } = isRecord(raw) ? raw : {};
      const durable = sourceFormat === 4 && isRecord(identity) && isString(identity.namespace) && isLayout4DurableRecord(identity.namespace);
      const event = {
        kind, seq, version, at,
        ...(identity === undefined ? {} : { identity }), ...(body === undefined ? {} : { body }),
        ...(durable && manifest !== undefined ? { manifest } : {}),
      };
      if (!exportedEvent(event)) return yield* refuse(`Tenant "${tenant}": its export holds an event this migration cannot read (seq ${String(seq)}).`);
      events.push(event);
    }
    return events;
  });

  const checkDurableHistory = (tenant: string, events: ReadonlyArray<ExportedEvent>, backup: ReadonlyArray<ExportedEvent>) => Effect.gen(function* () {
    const live = (entries: ReadonlyArray<ExportedEvent>) => {
      const records = new Map<number, string>();
      for (const event of entries) {
        if (event.kind === "retract") records.delete(event.seq);
        else if (event.identity !== undefined && isLayout4DurableRecord(event.identity.namespace)) {
          records.set(event.seq, JSON.stringify([event.identity, event.version, event.body, event.manifest]));
        }
      }
      return records;
    };
    const fromLog = live(events), fromRecords = live(backup);
    if (fromLog.size !== fromRecords.size || [...fromRecords].some(([seq, record]) => fromLog.get(seq) !== record)) {
      return yield* refuse(`Partition "${tenant}" has durable records that differ between its log and backup export.`);
    }
  });

  const exported = Effect.gen(function* () {
    yield* integration(() => mkdir(out, { recursive: true }));
    const tenants = yield* answered(yield* run(opened.database.tenants), arrayOf(isString), "its Tenants");
    const status = yield* run(opened.database.maintenance.status);
    const shardsStatus = sourceFormat === 2 ? yield* answered(status, shardStatus, "its maintenance status") : [];
    const partitionsStatus = sourceFormat === 4 ? yield* answered(status, partitionStatus, "its partition status") : [];
    const topology = opened.database.topology;
    if (topology !== undefined && Object.keys(topology.subdivision.current().tenants).length > 0) {
      return yield* refuse("This migration cannot carry divided Tenants. Nothing was changed.");
    }
    const placements = topology === undefined
      ? {}
      : yield* answered(topology.placement.current().collections, placementClasses, "its collection placements");
    const indexes = sourceFormat === 4 && opened.database.crossTenantIndexes !== undefined
      ? yield* answered(yield* run(opened.database.crossTenantIndexes.list), arrayOf(isCrossTenantIndexDefinition), "its cross-Tenant indexes")
      : [];
    const knownPartitions = new Set([GLOBAL_TENANT, TOPOLOGY_SHARD, "zv.cti", ...indexes.map(({ name }) => `zv.cti.${name}`)]);
    for (const { partition } of partitionsStatus) {
      if (isReservedTenantId(partition) && !knownPartitions.has(partition)) {
        return yield* refuse(`Reserved partition "${partition}" has no migration rule. Nothing was changed.`);
      }
    }
    const global = sourceFormat === 2
      ? shardsStatus.find(({ shard }) => shard === GLOBAL_SHARD)
      : partitionsStatus.find(({ shard, partition }) => shard === GLOBAL_SHARD && partition === GLOBAL_TENANT);
    const partitions = global === undefined ? tenants : [GLOBAL_TENANT, ...tenants];
    const files: Array<ExportManifest["tenants"][number]> = [];
    for (const [index, tenant] of partitions.entries()) {
      const shard = tenant === GLOBAL_TENANT ? GLOBAL_SHARD : opened.database.shardOf(tenant);
      const entry = tenant === GLOBAL_TENANT ? global : sourceFormat === 2
        ? shardsStatus.find((candidate) => candidate.shard === shard)
        : partitionsStatus.find((candidate) => candidate.shard === shard && candidate.partition === tenant);
      const tenantApi = tenant === GLOBAL_TENANT ? opened.database.global : opened.database.forTenant(tenant);
      if (entry === undefined || tenantApi === undefined) return yield* refuse(`Partition "${tenant}" cannot be opened for export.`);
      const history: TenantHistory = entry.compactedTo > 0 ? "state" : "log";
      let events: ExportedEvent[];
      if (sourceFormat === 4) {
        const leader = (yield* run(opened.database.followers.source(tenant))) as EarlierLeaderSource;
        const stats = yield* answered(yield* run(leader.stats), leaderStats, `the log status of "${tenant}"`);
        if (stats.seeding || (stats.lineage?.length ?? 0) > 0) {
          return yield* refuse(`Tenant "${tenant}" is a branch or unfinished copy. This migration cannot carry its lineage. Nothing was changed.`);
        }
        if (stats.compactedTo !== entry.compactedTo || stats.head < 0 || (history === "log" && stats.head >= EXPORT_EVENT_CAP)) {
          return yield* refuse(`Partition "${tenant}" has an inconsistent or oversized log.`);
        }
        const backup = yield* backupOf(tenant, tenantApi);
        events = history === "log" ? yield* historyOf(tenant, leader, stats.head) : backup;
        if (history === "log") yield* checkDurableHistory(tenant, events, backup);
      } else {
        events = yield* backupOf(tenant, tenantApi);
      }
      yield* matchesEarlierEngine(tenant, tenantApi, events);
      if (tenant === GLOBAL_TENANT && events.length === 0) continue;

      const file = `tenant-${index}.ndjson`;
      const handle = yield* integration(() => open(join(out, file), "w", 0o600));
      yield* Effect.gen(function* () {
        yield* integration(() => handle.write(`${JSON.stringify({ tenant, history, events: events.length })}\n`));
        for (let at = 0; at < events.length; at += PAGE) {
          const lines = events.slice(at, at + PAGE).map((event) => JSON.stringify(event)).join("\n");
          yield* integration(() => handle.write(`${lines}\n`));
        }
      }).pipe(Effect.ensuring(integration(() => handle.close()).pipe(Effect.orDie)));
      files.push({ tenant, file, events: events.length, history });
    }
    yield* integration(() => writeFile(join(out, "manifest.json"), JSON.stringify({
      format: DATA_EXPORT_FORMAT, tenants: files, placements, crossTenantIndexes: indexes.map(crossTenantIndexDefinitionOf),
    } satisfies ExportManifest)));
  });
  yield* exported.pipe(Effect.ensuring(integration(() => opened.close()).pipe(Effect.orDie)));
});

Effect.runFork(program.pipe(
  Effect.catch((error) => Effect.sync(() => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.message.startsWith("REFUSED") ? 3 : 1;
  })),
));
