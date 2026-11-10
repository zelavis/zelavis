import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat, statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Data, Effect, Stream } from "effect";
import { evaluate, integration, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { arrayOf, isJsonObject, isSafeInteger, isString, isUnknown, objectFields, optional, parseJson, type JsonValidator } from "../core/json-validation.js";
import { CARRY_COLLECTION, CARRY_DOCUMENTS, REPLAY_HISTORY, type CarriedDocument, type CarryCollectionInput, type CarryDocumentsInput, type ReplayedChange, type ReplayHistoryInput } from "../db/document-writes.js";
import { ZELAVIS_DB_BACKUP_V1, type BackupEvent, type BackupsApi } from "../db/backup.js";
import { crossTenantIndexDefinitionOf } from "../db/cross-tenant-index.js";
import { GLOBAL_TENANT } from "../db/topology.js";
import { SYSTEM_PLACEMENTS } from "../db/topology-store.js";
import type { DocumentsApi } from "../db/document-model.js";
import { openNodeDatabase, readShardLocations } from "../db/node-host.js";
import {
  comparableDocument, EXPORT_EVENT_CAP, exportedDocument, exportedEvent, exportHeader, exportManifest, isExportTime, isLayout4DurableRecord, MAX_EXPORT_LINE_CHARS,
  readableLayouts, sourceNamesOf, type ExportedDocument, type ExportedEvent, type ExportHeader, type SourceNames,
} from "./_data-export-format.js";

/**
 * Brings a database written by an earlier release forward to the layout this build writes.
 *
 * The earlier release's own engine exports every Tenant (`_data-export-worker`, which also checks the export against that
 * engine's own reads), and the records are recreated here through the documents API, the only door that derives the lenses
 * itself. A backup restore does not do this for layout 2, which named records and their index entries by tenant, so a
 * restored record would be stored but invisible. It reads layouts 2 and 4, each by its own names (`SOURCE_NAMES`), taken
 * from the layout the earlier release declares (`sourceFormat`); any other is refused before anything is copied.
 *
 * A Tenant whose earlier log was whole (`log`) has its document history replayed: every put and deletion of a collection
 * that still exists becomes one event here, in order, at its original time, with the document's version and times
 * (`REPLAY_HISTORY`), so the change feed, and a time series rebuilt from it, are what they were. The replay refuses
 * nothing the earlier engine accepted; the final state is then held to the collections' constraints as they stand
 * (`Settle`) and compared, document by document, with the export. A Tenant whose earlier log had been compacted (`state`)
 * has only its final documents to recreate, each with its id, data, version, times and expiry.
 *
 * Not carried: log positions, so a cursor issued before the migration is refused and its consumer reads from the start;
 * collection events in place (each collection is created once, in its final definition, at the time of the Tenant's
 * first event); the history of collections that no longer exist, or of an earlier collection of the same name
 * (counted); schema history (saved versions are recreated, then the active one activated); projection checkpoints,
 * time-series state, and layout-2 idempotency receipts (counted in `dropped`). Layout 4 also carries durable
 * workload, workflow, outbox, aggregate and idempotency records and rebuilds cross-Tenant indexes from their definitions.
 *
 * Each partition's export is streamed for indexing, document replay, verification and durable restore. The working
 * memory is one index entry per distinct record plus one batch and one line, independent of the history's length.
 *
 * It only reads the source and writes under `workDirectory`, so a failure leaves the source exactly as it was and removes
 * the staging it made. Swapping the result in, and keeping the old data, belong to the caller.
 */
export class DataMigrationFailure extends Data.TaggedError("DataMigrationFailure")<{ readonly message: string; readonly cause?: unknown }> {}

export interface DataMigrationInput {
  /** The earlier layout's shard directory. Copied, never opened in place. */
  readonly sourceShards: string;
  /** The layout the earlier engine wrote (`metadata.dataFormat` of its release): how its records are named. */
  readonly sourceFormat: number;
  /** Must not exist yet; the staging and the migrated shards live here. */
  readonly workDirectory: string;
  /** The earlier release's private Node and the `platform` directory of its release tree. */
  readonly oldNode: string;
  readonly oldPlatform: string;
  /** The compiled `_data-export-worker.js`. */
  readonly exportWorker: string;
  readonly exportTimeoutMs?: number;
  /** Told each phase's name as it ends, so a long migration can report where its time went. */
  readonly onPhase?: (phase: string) => void;
  /** Free bytes where the staging goes; read from the file system when omitted. Tests set it. */
  readonly freeBytes?: number;
}

export interface DataMigrationReport {
  readonly shardsDirectory: string;
  readonly tenants: number;
  readonly collections: number;
  /** Schema versions recreated, and which versions are active. */
  readonly schemas: number;
  readonly documents: number;
  /** Document events of the earlier history (puts and deletions) recreated in order, each at its original time. */
  readonly eventsCarried: number;
  /** Tenants whose earlier log had been compacted: exported as state, so only their final documents are recreated. */
  readonly tenantsWithoutHistory: number;
  /** Documents of those Tenants past their first version: each keeps its version; its earlier versions' events are not carried. */
  readonly documentsWithHistoryDropped: number;
  /** History events of collections that do not exist at the export (dropped, or an earlier collection of the same name), not carried. */
  readonly eventsOfDroppedCollections: number;
  /** Record kinds the earlier engine kept that are short-lived or rebuilt, and are not carried. */
  readonly dropped: Readonly<Record<string, number>>;
}

/** Bytes a directory tree holds; staging needs several times this: a copy, the export and the migrated database. */
const treeBytes = (directory: string): Effect.Effect<number, DataMigrationFailure> => Effect.gen(function* () {
  let total = 0;
  const entries = yield* attempt("The data to migrate cannot be measured.", () => readdir(directory, { withFileTypes: true }));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += yield* treeBytes(path);
    else if (entry.isFile()) total += (yield* attempt("The data to migrate cannot be measured.", () => stat(path))).size;
  }
  return total;
});
/** A copy of the source, its export (about as large) and the migrated database, plus room to spare. */
const STAGING_FACTOR = 3.5;
/** Changes, inserts or settled ids per request: what one transaction of the migrated database holds. */
const WRITE_BATCH = 500;
const COLLECTION_FIELDS = ["surface", "metadata", "indexes", "checks", "references", "analyzer", "spatial", "embedding", "edges", "measures", "columns"] as const;
const SCHEMA_NAMESPACE = "zv.schema", ACTIVE_SCHEMA_NAMESPACE = "zv.schema.active";

const fail = (message: string, cause?: unknown) => new DataMigrationFailure({ message, ...(cause === undefined ? {} : { cause }) });
const attempt = <A>(message: string, operation: () => A | PromiseLike<A>): Effect.Effect<A, DataMigrationFailure> =>
  integration(operation).pipe(Effect.mapError((error) => fail(`${message} ${error.message}`.trim(), error)));
const iso = (ms: number) => new Date(ms).toISOString();

const runExport = (input: DataMigrationInput, shards: string, out: string) =>
  Effect.callback<void, DataMigrationFailure>((resume) => {
    const child = spawn(input.oldNode, [input.exportWorker, "--platform", input.oldPlatform, "--source-format", String(input.sourceFormat), "--shards", shards, "--out", out],
      { stdio: ["ignore", "ignore", "pipe"], env: { PATH: "/usr/bin:/bin" }, shell: false });
    let stderr = "";
    let settled = false;
    const timeoutMs = input.exportTimeoutMs ?? 30 * 60_000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resume(Effect.fail(fail(`The earlier engine's export did not finish within ${timeoutMs} ms and was stopped.`)));
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString("utf8"); });
    child.once("error", (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resume(Effect.fail(fail("The earlier engine could not be started to export the data.", cause)));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resume(code === 0 ? Effect.void : Effect.fail(fail(`The earlier engine's export failed (exit ${code ?? "signal"}): ${stderr.trim().slice(0, 2000)}`)));
    });
    return Effect.sync(() => { if (!settled) { settled = true; clearTimeout(timer); child.kill("SIGKILL"); } });
  });

/** What the recreated document is given of the earlier one; a document the earlier engine kept without times inserts fresh. */
const carriedOf = (d: ExportedDocument): CarriedDocument | undefined =>
  typeof d.createdAt === "string" && typeof d.updatedAt === "string"
    ? { version: d.version ?? 1, createdAt: d.createdAt, updatedAt: d.updatedAt }
    : undefined;

/** A record body of the export, as the earlier engine stored it, held to the shape this migration reads. */
const bodyOf = <A>(body: string | undefined, check: JsonValidator<A>, what: string) =>
  evaluate(() => parseJson(Buffer.from(body ?? "", "base64").toString("utf8"), check, what))
    .pipe(Effect.mapError((error) => fail(`${what} cannot be read: ${error.message}`, error)));

const collectionBody = objectFields<{ readonly name: string; readonly createdAt: unknown; readonly references: ReadonlyArray<{ readonly collection: string | undefined }> | undefined }>({
  name: isString, createdAt: isUnknown,
  references: optional(arrayOf(objectFields<{ readonly collection: string | undefined }>({ collection: optional(isString) }))),
});
const schemaBody = objectFields<{ readonly collection: string; readonly version: number; readonly fields: ReadonlyArray<unknown> }>({
  collection: isString, version: isSafeInteger, fields: arrayOf(isJsonObject),
});
const activeSchemaBody = objectFields<{ readonly version: number }>({ version: isSafeInteger });

/**
 * One streamed read of a Tenant's export: the header line, then every event in order with its index. A line is held to
 * `MAX_EXPORT_LINE_CHARS` while it is gathered, so a file without line ends cannot fill memory; the header must name
 * this Tenant and fewer events than the earlier engine's export cap, and the file must hold exactly that many.
 */
const readExport = (
  file: string,
  tenant: string,
  visit: (event: ExportedEvent, index: number) => Effect.Effect<void, DataMigrationFailure>,
): Effect.Effect<ExportHeader, DataMigrationFailure> => Effect.gen(function* () {
  let header: ExportHeader | undefined;
  let count = 0;
  let pending = "";
  const tooLong = () => fail(`The export of Tenant "${tenant}" has a line over ${MAX_EXPORT_LINE_CHARS} characters.`);
  const line = (source: string) => Effect.gen(function* () {
    if (header === undefined) {
      const read = yield* evaluate(() => parseJson(source, exportHeader, "Data export header"))
        .pipe(Effect.mapError((error) => fail(`The export of Tenant "${tenant}" has a header that cannot be read: ${error.message}`, error)));
      if (read.tenant !== tenant) return yield* fail(`The export of Tenant "${tenant}" has a header for "${read.tenant}".`);
      if (read.events >= EXPORT_EVENT_CAP) return yield* fail(`The export of Tenant "${tenant}" holds ${read.events} events, which reaches the earlier engine's export cap.`);
      header = read;
      return;
    }
    if (count >= header.events) return yield* fail(`The export of Tenant "${tenant}" holds more events than the ${header.events} its header names.`);
    const event = yield* evaluate(() => parseJson(source, exportedEvent, "Data export event"))
      .pipe(Effect.mapError((error) => fail(`The export of Tenant "${tenant}" has an event that cannot be read (line ${count + 2}): ${error.message}`, error)));
    yield* visit(event, count);
    count += 1;
  });
  yield* Stream.fromAsyncIterable(
    createReadStream(file, { encoding: "utf8" }) as AsyncIterable<string>,
    (cause) => fail(`The export of Tenant "${tenant}" cannot be read.`, cause),
  ).pipe(Stream.runForEach((chunk) => Effect.gen(function* () {
    let from = 0;
    for (;;) {
      const end = chunk.indexOf("\n", from);
      if (end < 0) break;
      if (pending.length + (end - from) > MAX_EXPORT_LINE_CHARS) return yield* tooLong();
      const source = pending + chunk.slice(from, end);
      pending = "";
      from = end + 1;
      yield* line(source);
    }
    pending += chunk.slice(from);
    if (pending.length > MAX_EXPORT_LINE_CHARS) return yield* tooLong();
  })));
  // The worker ends every line; a last one without its end is still a line, and fails as one if it was cut short.
  if (pending.length > 0) yield* line(pending);
  if (header === undefined) return yield* fail(`The export of Tenant "${tenant}" has no header.`);
  const read: ExportHeader = header;
  if (count !== read.events) return yield* fail(`The export of Tenant "${tenant}" is incomplete: ${count} of ${read.events} events.`);
  return read;
});

/** One old record of the export: where it is stored, the index of its last put and of the first put of its current life. */
interface RecordTrack { readonly namespace: string; readonly key: string; since: number; lastPut: number; live: boolean }
interface LiveCollection { readonly seq: number; readonly from: number; readonly body: string }
/**
 * What the first pass learns of a Tenant's export, and all that is kept of it between passes: one entry per distinct old
 * record. Old record identifiers were shard-wide and mean something only here; nothing maps them into the new database.
 */
interface TenantIndex {
  readonly header: ExportHeader;
  readonly records: Map<number, RecordTrack>;
  /** Collections live at the end, by name: their record's seq, the index of its first put, its last body. */
  readonly collections: Map<string, LiveCollection>;
  /** Live documents per live collection. */
  readonly documents: Map<string, number>;
  readonly schemas: Map<number, string>;
  readonly activeSchemas: Map<number, { readonly key: string; readonly body: string }>;
  readonly dropped: Record<string, number>;
  readonly firstAt: number | undefined;
}

const indexTenant = (file: string, tenant: string, names: SourceNames, carryDurable: boolean): Effect.Effect<TenantIndex, DataMigrationFailure> => Effect.gen(function* () {
  const collectionNamespace = names.collectionNamespace(tenant), documentPrefix = names.documentPrefix(tenant);
  const records = new Map<number, RecordTrack>();
  // The last body of every record whose content the migration reads whole: collections and schemas, never documents.
  const bodies = new Map<number, string>();
  const namespaces = new Map<string, string>();
  let firstAt: number | undefined;
  const header = yield* readExport(file, tenant, (event, index) => Effect.gen(function* () {
    if (index === 0) firstAt = event.at;
    if (event.kind === "retract") {
      const track = records.get(event.seq);
      if (track === undefined) return yield* fail(`Tenant "${tenant}" has a retraction of an unknown record (seq ${event.seq}) in its export.`);
      track.live = false;
      bodies.delete(event.seq);
      return;
    }
    if (event.identity === undefined) return yield* fail(`Tenant "${tenant}" has a put without an identity in its export.`);
    // One string per distinct namespace, however many records share it.
    const namespace = namespaces.get(event.identity.namespace) ?? event.identity.namespace;
    namespaces.set(namespace, namespace);
    if (namespace.startsWith("doc/") && !namespace.startsWith(documentPrefix)) {
      return yield* fail(`Tenant "${tenant}" has a document under another Tenant's namespace "${namespace}" in its export.`);
    }
    const track = records.get(event.seq);
    if (track === undefined) {
      records.set(event.seq, { namespace, key: event.identity.key, since: index, lastPut: index, live: true });
    } else {
      if (track.namespace !== namespace || track.key !== event.identity.key) {
        return yield* fail(`Tenant "${tenant}" has a record (seq ${event.seq}) stored under two names in its export.`);
      }
      if (!track.live) track.since = index;
      track.lastPut = index;
      track.live = true;
    }
    if (namespace === collectionNamespace || namespace === SCHEMA_NAMESPACE || namespace === ACTIVE_SCHEMA_NAMESPACE) {
      if (event.body === undefined) return yield* fail(`Tenant "${tenant}" has a put without a body (seq ${event.seq}) in its export.`);
      bodies.set(event.seq, event.body);
    }
  }));

  const collections = new Map<string, LiveCollection>();
  const schemas = new Map<number, string>();
  const activeSchemas = new Map<number, { readonly key: string; readonly body: string }>();
  const documents = new Map<string, number>();
  const dropped: Record<string, number> = {};
  const unknown: Record<string, number> = {};
  for (const [seq, track] of records) {
    if (!track.live) continue;
    if (track.namespace === collectionNamespace) collections.set(track.key, { seq, from: track.since, body: bodies.get(seq) ?? "" });
    else if (track.namespace === SCHEMA_NAMESPACE) schemas.set(seq, bodies.get(seq) ?? "");
    else if (track.namespace === ACTIVE_SCHEMA_NAMESPACE) activeSchemas.set(seq, { key: track.key, body: bodies.get(seq) ?? "" });
    else if (track.namespace.startsWith(documentPrefix)) {
      const collection = track.namespace.slice(documentPrefix.length);
      documents.set(collection, (documents.get(collection) ?? 0) + 1);
    } else if (!carryDurable || !isLayout4DurableRecord(track.namespace)) {
      const kind = track.namespace.split("/")[0]!;
      const counted = names.droppedPrefixes.some((prefix) => track.namespace.startsWith(prefix)) ? dropped : unknown;
      counted[kind] = (counted[kind] ?? 0) + 1;
    }
  }
  if (Object.keys(unknown).length > 0) return yield* fail(`Tenant "${tenant}" holds records this migration cannot recreate yet: ${JSON.stringify(unknown)}. Nothing was changed.`);
  for (const collection of documents.keys()) {
    if (!collections.has(collection)) return yield* fail(`Tenant "${tenant}" has documents of a collection that no longer exists ("${collection}") in its export.`);
  }
  return { header, records, collections, documents, schemas, activeSchemas, dropped, firstAt };
});

/** A document put of the export, read and held to the record it is stored under. */
const documentOf = (event: ExportedEvent, tenant: string, collection: string, key: string) => Effect.gen(function* () {
  const stored = yield* bodyOf(event.body, exportedDocument, `Exported document "${key}" of Tenant "${tenant}"`);
  if (stored.collection !== collection || stored.id !== key) {
    return yield* fail(`Document "${key}" of Tenant "${tenant}" names another collection or id than the record it is stored under.`);
  }
  return stored;
});

/**
 * The second pass of a `log` Tenant: every document event of a collection that exists at the end, from that collection's
 * creation on, becomes one replayed change. Earlier events of the name belong to a collection since dropped.
 */
const replayLog = (file: string, index: TenantIndex, documents: DocumentsApi, tenant: string, names: SourceNames) => Effect.gen(function* () {
  const documentPrefix = names.documentPrefix(tenant);
  let changes: Array<ReplayedChange> = [];
  let eventsCarried = 0, eventsOfDroppedCollections = 0;
  const flush = Effect.gen(function* () {
    if (changes.length === 0) return;
    const request = { operations: [], [REPLAY_HISTORY]: { _tag: "Changes", changes } } satisfies ReplayHistoryInput & Record<string, unknown>;
    yield* documents.write(request).pipe(Effect.mapError((error) => fail(`History of Tenant "${tenant}" could not be replayed: ${error._tag}.`, error)));
    eventsCarried += changes.length;
    changes = [];
  });
  yield* readExport(file, tenant, (event, at) => Effect.gen(function* () {
    const track = index.records.get(event.seq);
    if (track === undefined || !track.namespace.startsWith(documentPrefix)) return;
    const collection = track.namespace.slice(documentPrefix.length);
    const live = index.collections.get(collection);
    if (live === undefined || at < live.from) {
      eventsOfDroppedCollections += 1;
      return;
    }
    if (event.kind === "retract") changes.push({ _tag: "Retract", collection, id: track.key, at: event.at });
    else {
      const stored = yield* documentOf(event, tenant, collection, track.key);
      if (stored.version === undefined) return yield* fail(`Document "${stored.id}" of Tenant "${tenant}" has no version in the earlier engine's export.`);
      changes.push({
        _tag: "Put", collection, id: stored.id, data: stored.data as never, version: stored.version,
        createdAt: stored.createdAt ?? iso(event.at), updatedAt: stored.updatedAt ?? iso(event.at),
        ...(stored.expiresAt === undefined ? {} : { expiresAt: stored.expiresAt }), at: event.at,
      });
    }
    if (changes.length >= WRITE_BATCH) yield* flush;
  }));
  yield* flush;
  return { eventsCarried, eventsOfDroppedCollections };
});

/**
 * The second pass of a `state` Tenant: its final documents, inserted under everything a document must satisfy, in the
 * export's order. The earlier engine lists a state export by record identifier, so the documents keep the order their
 * identifiers had, which is the order a read without one answers in.
 */
const recreateState = (file: string, index: TenantIndex, documents: DocumentsApi, tenant: string, names: SourceNames) => Effect.gen(function* () {
  const documentPrefix = names.documentPrefix(tenant);
  let batch: Array<ExportedDocument> = [];
  let recreated = 0, historyDropped = 0;
  const flush = Effect.gen(function* () {
    if (batch.length === 0) return;
    const write = {
      operations: batch.map((d) => ({
        _tag: "Insert" as const, collection: d.collection, id: d.id, data: d.data as never,
        ...(typeof d.expiresAt === "string" ? { expiresAt: d.expiresAt } : {}),
      })),
      [CARRY_DOCUMENTS]: batch.map(carriedOf),
    } satisfies CarryDocumentsInput & Record<string, unknown>;
    yield* documents.write(write).pipe(Effect.mapError((error) => fail(`Documents of Tenant "${tenant}" could not be recreated: ${error._tag}.`, error)));
    recreated += batch.length;
    for (const d of batch) if ((d.version ?? 1) > 1) historyDropped += 1;
    batch = [];
  });
  yield* readExport(file, tenant, (event, at) => Effect.gen(function* () {
    const track = index.records.get(event.seq);
    if (track === undefined || !track.live || track.lastPut !== at || !track.namespace.startsWith(documentPrefix)) return;
    batch.push(yield* documentOf(event, tenant, track.namespace.slice(documentPrefix.length), track.key));
    if (batch.length >= WRITE_BATCH) yield* flush;
  }));
  yield* flush;
  return { documents: recreated, documentsWithHistoryDropped: historyDropped };
});

/**
 * The third pass: the recreated Tenant holds exactly the documents the earlier engine exported, with the same data,
 * version, times and expiry, and, for a replayed history, a final state the collections' constraints allow as they stand.
 */
const verifyDocuments = (file: string, index: TenantIndex, documents: DocumentsApi, tenant: string, names: SourceNames) => Effect.gen(function* () {
  const documentPrefix = names.documentPrefix(tenant);
  const replayed = index.header.history === "log";
  const unsettled = new Map<string, Array<string>>();
  const settle = (collection: string, ids: ReadonlyArray<string>) => {
    const request = { operations: [], [REPLAY_HISTORY]: { _tag: "Settle", collection, ids } } satisfies ReplayHistoryInput & Record<string, unknown>;
    return documents.write(request).pipe(Effect.mapError((error) => fail(`The final state of Tenant "${tenant}" breaks a constraint of "${collection}": ${error._tag}.`, error)));
  };
  yield* readExport(file, tenant, (event, at) => Effect.gen(function* () {
    const track = index.records.get(event.seq);
    if (track === undefined || !track.live || track.lastPut !== at || !track.namespace.startsWith(documentPrefix)) return;
    const collection = track.namespace.slice(documentPrefix.length);
    const stored = yield* documentOf(event, tenant, collection, track.key);
    // A replay carries both times, the event's own where the earlier engine kept none; an insert only where it kept both.
    const timed = replayed || carriedOf(stored) !== undefined;
    const expected = comparableDocument({
      data: stored.data, version: stored.version ?? 1, expiresAt: stored.expiresAt,
      createdAt: stored.createdAt ?? iso(event.at), updatedAt: stored.updatedAt ?? iso(event.at),
    }, timed);
    const found = yield* documents.findById({ collection, id: stored.id });
    if (found === undefined || comparableDocument(found, timed) !== expected) {
      return yield* fail(`Verification failed for "${tenant}/${collection}": document "${stored.id}" differs after recreation.`);
    }
    if (!replayed) return;
    const ids = unsettled.get(collection) ?? [];
    ids.push(stored.id);
    unsettled.set(collection, ids);
    if (ids.length >= WRITE_BATCH) {
      unsettled.delete(collection);
      yield* settle(collection, ids);
    }
  }));
  for (const [collection, ids] of unsettled) yield* settle(collection, ids);
  for (const collection of index.collections.keys()) {
    const expected = index.documents.get(collection) ?? 0;
    const counted = yield* documents.count({ collection }).pipe(Effect.mapError((error) => fail(`Collection "${collection}" cannot be counted: ${error._tag}.`, error)));
    if (counted !== expected) return yield* fail(`Verification failed for "${tenant}/${collection}": ${expected} documents exported, ${counted} recreated.`);
  }
});

/**
 * The durable namespaces of layout 4 use the same keys and lenses in layout 5. The backup API can restore them
 * beside recreated documents because they have no edges into other records. It assigns internal identifiers in the
 * destination; the stored identities, application IDs, revisions, and payloads survive. Layout 2 uses no such restore.
 */
const restoreDurableRecords = (file: string, tenant: string, index: TenantIndex, backups: BackupsApi) => Effect.gen(function* () {
  const expected = new Map<string, string>();
  const keyOf = (identity: NonNullable<BackupEvent["identity"]>) => JSON.stringify([identity.namespace, identity.key]);
  const fingerprint = (event: BackupEvent) =>
    createHash("sha256").update(JSON.stringify([event.version, event.body, event.manifest])).digest("hex");
  let batch: BackupEvent[] = [];
  const restore = Effect.gen(function* () {
    if (batch.length === 0) return;
    const result = yield* backups.restoreTenant({
      format: ZELAVIS_DB_BACKUP_V1, tenantId: tenant, exportedAt: iso(Date.now()), events: batch,
    }, { into: "merge" }).pipe(Effect.mapError((error) => fail(`Durable records of "${tenant}" could not be restored: ${error._tag}.`, error)));
    if (result.events !== batch.length || result.superseded !== 0) {
      return yield* fail(`Durable records of "${tenant}" did not restore as new records.`);
    }
    batch = [];
  });

  yield* readExport(file, tenant, (event, position) => Effect.gen(function* () {
    const { identity } = event;
    if (event.kind !== "put" || identity === undefined || !isLayout4DurableRecord(identity.namespace)) return;
    const tracked = index.records.get(event.seq);
    if (!tracked?.live || tracked.lastPut !== position) return;
    if (event.body === undefined || event.manifest === undefined || event.manifest.edges.length !== 0) {
      return yield* fail(`Durable record "${identity.namespace}/${identity.key}" of "${tenant}" cannot be restored without its body and independent lenses.`);
    }
    let body = event.body;
    if (identity.namespace === "zv.aggregate") {
      // Keep the last published result even if it is stale. Its old cursor would point into a different log.
      const aggregate = yield* bodyOf(body, isJsonObject, `Aggregate "${identity.key}" of "${tenant}"`);
      const { checkpoint: _checkpoint, ...retained } = aggregate;
      body = Buffer.from(JSON.stringify(retained)).toString("base64");
    }
    const kept = { kind: "put", seq: event.seq, version: event.version, at: event.at, identity, body, manifest: event.manifest } satisfies BackupEvent;
    const key = keyOf(identity);
    if (expected.has(key)) return yield* fail(`Durable record "${identity.namespace}/${identity.key}" occurs twice in "${tenant}".`);
    expected.set(key, fingerprint(kept));
    batch.push(kept);
    if (batch.length >= WRITE_BATCH) yield* restore;
  }));
  yield* restore;
  if (expected.size === 0) return;

  let cursor: string | undefined;
  for (;;) {
    const page = yield* backups.exportPage({ ...(cursor === undefined ? {} : { cursor }), limit: WRITE_BATCH })
      .pipe(Effect.mapError((error) => fail(`Durable records of "${tenant}" could not be verified: ${error._tag}.`, error)));
    for (const event of page.entries) {
      const { identity } = event;
      if (identity === undefined || !isLayout4DurableRecord(identity.namespace)) continue;
      const key = keyOf(identity);
      if (event.kind !== "put" || expected.get(key) !== fingerprint(event)) {
        return yield* fail(`Durable record "${identity.namespace}/${identity.key}" of "${tenant}" differs after restore.`);
      }
      expected.delete(key);
    }
    if (page.consistent) break;
    cursor = page.cursor;
  }
  if (expected.size > 0) return yield* fail(`Verification did not find ${expected.size} restored durable records of "${tenant}".`);
});

export const migrateDataLayout = Effect.fn("DataMigration.migrate")(function* (input: DataMigrationInput): Effect.fn.Return<DataMigrationReport, DataMigrationFailure | IntegrationFailure> {
  const names = sourceNamesOf(input.sourceFormat);
  if (names === undefined) return yield* fail(`Data written in layout ${input.sourceFormat} cannot be migrated: this release reads layouts ${readableLayouts()}. Nothing was changed.`);
  const work = resolve(input.workDirectory), source = join(work, "source"), exported = join(work, "export"), migrated = join(work, "shards");
  const existing = yield* Effect.result(integration(() => stat(work)));
  if (existing._tag === "Success") return yield* fail(`The staging directory ${work} already exists; a migration never reuses one.`);
  const sourceStats = yield* attempt("The data to migrate cannot be read.", () => stat(resolve(input.sourceShards)));
  if (!sourceStats.isDirectory()) return yield* fail("The data to migrate is not a directory.");

  const locations = yield* evaluate(() => readShardLocations(resolve(input.sourceShards)));
  if (locations.remote.length > 0 || locations.replicas.length > 0) {
    return yield* fail("The database has shards or replicas on other Nodes. This migration requires local shards. Nothing was changed.");
  }
  const sourceBytes = yield* treeBytes(resolve(input.sourceShards));
  const fileSystem = input.freeBytes === undefined ? yield* attempt("The free space cannot be read.", () => statfs(dirname(work))) : undefined;
  const free = input.freeBytes ?? Number(fileSystem!.bavail) * Number(fileSystem!.bsize);
  if (free < sourceBytes * STAGING_FACTOR) return yield* fail(`There is not enough free space to migrate: about ${Math.ceil(sourceBytes * STAGING_FACTOR)} bytes are needed beside the data, ${free} are free. Nothing was changed.`);

  const run = Effect.gen(function* () {
    yield* attempt("The staging directory could not be created.", () => mkdir(work, { recursive: true, mode: 0o700 }));
    yield* attempt("The data could not be copied for export.", () => cp(resolve(input.sourceShards), source, { recursive: true }));
    input.onPhase?.("copy for export");
    yield* runExport(input, source, exported);
    input.onPhase?.("export by the earlier engine");
    const manifestSource = yield* attempt("The export is incomplete.", () => readFile(join(exported, "manifest.json"), "utf8"));
    const manifest = yield* evaluate(() => parseJson(manifestSource, exportManifest, "Data export manifest"));

    const opened = yield* attempt("The migrated database could not be created.", () => openNodeDatabase({ directory: migrated, crossTenantRefresh: false }));
    input.onPhase?.("create the migrated database");
    return yield* Effect.gen(function* () {
      for (const [collection, placement] of Object.entries(manifest.placements ?? {})) {
        if (Object.hasOwn(SYSTEM_PLACEMENTS, collection)) continue;
        yield* opened.database.topology.placement.declare(collection, placement)
          .pipe(Effect.mapError((error) => fail(`Collection placement "${collection}" could not be carried: ${error._tag}.`, error)));
      }
      const carryDurable = input.sourceFormat === 4;
      let tenants = 0, collections = 0, schemas = 0, documents = 0, eventsCarried = 0, tenantsWithoutHistory = 0, historyDropped = 0, eventsOfDroppedCollections = 0;
      const dropped: Record<string, number> = {};
      for (const entry of manifest.tenants) {
        const tenant = entry.tenant;
        const file = join(exported, entry.file);
        const tenantApi = tenant === GLOBAL_TENANT ? opened.database.global : opened.database.forTenant(tenant);
        if (tenant !== GLOBAL_TENANT) tenants += 1;
        const index = yield* indexTenant(file, tenant, names, carryDurable);
        if (index.header.history !== entry.history || index.header.events !== entry.events) {
          return yield* fail(`The export of Tenant "${tenant}" has a header that differs from the export's manifest.`);
        }
        for (const [kind, count] of Object.entries(index.dropped)) dropped[kind] = (dropped[kind] ?? 0) + count;
        const tenantDocuments = tenantApi.documents;

        // Collections first, in their final definition, a collection that references another after it; each at the time
        // of the Tenant's first event, so the log that follows reads in time order.
        const pending: Array<{ readonly name: string; readonly createdAt: unknown; readonly references: ReadonlyArray<{ readonly collection: string | undefined }> | undefined } & Record<string, unknown>> = [];
        for (const [name, live] of index.collections) {
          const body = yield* bodyOf(live.body, collectionBody, `Collection "${name}" of Tenant "${tenant}"`);
          if (body.name !== name) return yield* fail(`Collection "${name}" of Tenant "${tenant}" names another collection than the record it is stored under.`);
          pending.push(body as typeof pending[number]);
        }
        const created = new Set<string>();
        while (pending.length > 0) {
          const next = pending.findIndex((c) => (c.references ?? []).every((r) => r.collection === undefined || r.collection === c.name || created.has(r.collection)));
          if (next < 0) return yield* fail(`Tenant "${tenant}" has collections whose references cannot be ordered: ${pending.map((c) => c.name).join(", ")}.`);
          const [collection] = pending.splice(next, 1) as [typeof pending[number]];
          if (index.firstAt === undefined) return yield* fail(`Tenant "${tenant}" has a collection and no event in its export.`);
          const definition: Record<string, unknown> & CarryCollectionInput = {
            name: collection.name,
            [CARRY_COLLECTION]: { createdAt: isExportTime(collection.createdAt) ? collection.createdAt : iso(index.firstAt), at: index.firstAt },
          };
          for (const field of COLLECTION_FIELDS) if (collection[field] !== undefined) definition[field] = collection[field];
          yield* tenantDocuments.createCollection(definition as never).pipe(Effect.mapError((error) => fail(`Collection "${collection.name}" of Tenant "${tenant}" could not be recreated: ${error._tag}.`, error)));
          created.add(collection.name);
          collections += 1;
        }

        if (index.header.history === "log") {
          const replayed = yield* replayLog(file, index, tenantDocuments, tenant, names);
          eventsCarried += replayed.eventsCarried;
          eventsOfDroppedCollections += replayed.eventsOfDroppedCollections;
          for (const count of index.documents.values()) documents += count;
        } else {
          const recreated = yield* recreateState(file, index, tenantDocuments, tenant, names);
          if (tenant !== GLOBAL_TENANT) tenantsWithoutHistory += 1;
          documents += recreated.documents;
          historyDropped += recreated.documentsWithHistoryDropped;
        }
        yield* verifyDocuments(file, index, tenantDocuments, tenant, names);

        // Schemas go in last, saved inactive and then activated: an active schema would judge the documents as they come in, and the
        // earlier engine never checked what it already held when a schema was activated.
        const tenantSchemas = tenantApi.schemas;
        const savedSchemas: Array<{ readonly collection: string; readonly version: number; readonly fields: ReadonlyArray<unknown> }> = [];
        for (const body of index.schemas.values()) savedSchemas.push(yield* bodyOf(body, schemaBody, `A schema of Tenant "${tenant}"`));
        for (const schema of savedSchemas.sort((a, b) => a.collection.localeCompare(b.collection) || a.version - b.version)) {
          yield* tenantSchemas.save({ collection: schema.collection, version: schema.version, fields: schema.fields as never, activate: false })
            .pipe(Effect.mapError((error) => fail(`Schema ${schema.collection}@${schema.version} of Tenant "${tenant}" could not be recreated: ${error._tag}.`, error)));
          schemas += 1;
        }
        for (const record of index.activeSchemas.values()) {
          const collection = names.activeCollection(tenant, record.key);
          if (collection === undefined) return yield* fail(`Tenant "${tenant}" has an active-schema record this migration cannot read.`);
          const { version } = yield* bodyOf(record.body, activeSchemaBody, `The active schema of "${collection}" of Tenant "${tenant}"`);
          yield* tenantSchemas.activate(collection, version)
            .pipe(Effect.mapError((error) => fail(`Schema ${collection}@${version} of Tenant "${tenant}" could not be activated: ${error._tag}.`, error)));
        }
        const readBack = yield* tenantSchemas.listCollections.pipe(Effect.mapError((error) => fail(`Schemas of Tenant "${tenant}" cannot be read back.`, error)));
        for (const schema of savedSchemas) {
          const restored = yield* tenantSchemas.getVersion(schema.collection, schema.version);
          if (restored === undefined || JSON.stringify(restored.fields) !== JSON.stringify(schema.fields)) {
            return yield* fail(`Verification failed for "${tenant}": schema "${schema.collection}"@${schema.version} differs after recreation.`);
          }
        }
        for (const record of index.activeSchemas.values()) {
          const collection = names.activeCollection(tenant, record.key)!;
          const { version } = yield* bodyOf(record.body, activeSchemaBody, `The active schema of "${collection}" of Tenant "${tenant}"`);
          if (!readBack.some((schema) => schema.collection === collection && schema.activeVersion === version)) {
            return yield* fail(`Verification failed for "${tenant}": schema "${collection}"@${version} is not active.`);
          }
        }
        if (carryDurable) yield* restoreDurableRecords(file, tenant, index, tenantApi.backups);
      }
      const indexes = opened.database.crossTenantIndexes;
      for (const definition of manifest.crossTenantIndexes ?? []) {
        const restored = yield* indexes.define(definition)
          .pipe(Effect.mapError((error) => fail(`Cross-Tenant index "${definition.name}" could not be recreated: ${error._tag}.`, error)));
        if (JSON.stringify(crossTenantIndexDefinitionOf(restored)) !== JSON.stringify(definition)) {
          return yield* fail(`Cross-Tenant index "${definition.name}" differs after recreation.`);
        }
        const results = yield* indexes.refresh(definition.name)
          .pipe(Effect.mapError((error) => fail(`Cross-Tenant index "${definition.name}" could not be rebuilt: ${error._tag}.`, error)));
        if (results.length !== 1 || results[0]!.failures.length > 0) {
          return yield* fail(`Cross-Tenant index "${definition.name}" could not be rebuilt for every Tenant: ${JSON.stringify(results[0]?.failures ?? [])}.`);
        }
      }
      return {
        shardsDirectory: migrated, tenants, collections, schemas, documents, eventsCarried, tenantsWithoutHistory,
        documentsWithHistoryDropped: historyDropped, eventsOfDroppedCollections, dropped,
      } satisfies DataMigrationReport;
    }).pipe(Effect.ensuring(Effect.promise(() => opened.close()).pipe(Effect.orDie)));
  });

  // Staging this call made is removed on any failure; the source was only ever read.
  return yield* run.pipe(Effect.onError(() => attempt("", () => rm(work, { recursive: true, force: true })).pipe(Effect.orElseSucceed(() => undefined))));
});
