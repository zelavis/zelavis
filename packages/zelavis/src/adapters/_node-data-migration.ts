import { spawn } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, stat, statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Data, Effect } from "effect";
import { evaluate, integration, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { arrayOf, isJsonObject, isSafeInteger, isString, literal, objectFields, optional, parseJson } from "../core/json-validation.js";
import { CARRY_DOCUMENTS, type CarriedDocument, type CarryDocumentsInput } from "../db/document-writes.js";
import { openNodeDatabase } from "../db/node-host.js";

/**
 * Brings a database written by an earlier release forward to the layout this build writes.
 *
 * The earlier release's own engine exports every Tenant (`_data-export-worker`), and the records are recreated here through
 * the documents API, the only door that derives the lenses itself. A backup restore does not do this: the earlier layout named
 * records and their index entries by tenant, so a restored record would be stored but invisible. Each document keeps its id,
 * data, version, creation and update times and expiry, so a version a client read before the migration still means the same
 * document state after it. Its earlier versions' events are not carried: the change history restarts with one event per
 * document, at new log positions; the caller reports that.
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
  /** Documents past their first version: each keeps its version, and the events of its earlier versions are not carried. */
  readonly documentsWithHistoryDropped: number;
  /** Record kinds the earlier engine kept that are short-lived or rebuilt, and are not carried. */
  readonly dropped: Readonly<Record<string, number>>;
}

interface ExportedEvent {
  readonly kind: "put" | "retract";
  readonly seq: number;
  readonly identity?: { readonly namespace: string; readonly key: string } | undefined;
  readonly body?: string | undefined;
}
const exportedEvent = objectFields<ExportedEvent>({
  kind: literal("put", "retract"), seq: isSafeInteger,
  identity: optional(objectFields<{ readonly namespace: string; readonly key: string }>({ namespace: isString, key: isString })),
  body: optional(isString),
});
const exportManifest = objectFields<{ readonly format: "zelavis-data-export/1"; readonly tenants: ReadonlyArray<{ readonly tenant: string; readonly file: string }> }>({
  format: literal("zelavis-data-export/1"),
  tenants: arrayOf(objectFields<{ readonly tenant: string; readonly file: string }>({ tenant: isString, file: isString })),
});
const tenantExport = objectFields<{ readonly tenant: string; readonly events: ReadonlyArray<ExportedEvent> }>({ tenant: isString, events: arrayOf(exportedEvent) });

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
const WRITE_BATCH = 500;
const MAX_TENANT_FILE_BYTES = 512 * 1024 * 1024;
const COLLECTION_FIELDS = ["surface", "metadata", "indexes", "checks", "references", "analyzer", "spatial", "embedding", "edges", "measures", "columns"] as const;

/**
 * How an earlier layout names what this migration recreates, per Tenant.
 *
 * Layout 2 put the tenant into every name (`zv.collection/<tenant>`, an active schema keyed `<tenant>/<collection>`,
 * `zv.idempotency/<tenant>`). Layout 4 keeps each Tenant in a partition of its own, so its names carry no tenant. Documents
 * and saved schemas are read from their bodies, which name their collection in both. Idempotency receipts and projection
 * checkpoints are held per Tenant and short-lived or rebuilt here, so they are dropped. A layout not listed here is
 * refused before anything is read.
 */
interface SourceNames {
  readonly isCollection: (namespace: string) => boolean;
  /** The collection an active-schema record names, or nothing for one this layout would not have written. */
  readonly activeCollection: (tenant: string, key: string) => string | undefined;
  readonly droppedPrefixes: ReadonlyArray<string>;
}
const SOURCE_NAMES: Readonly<Record<number, SourceNames>> = {
  2: {
    isCollection: (namespace) => namespace.startsWith("zv.collection/"),
    activeCollection: (tenant, key) => key.startsWith(`${tenant}/`) ? key.slice(tenant.length + 1) : undefined,
    droppedPrefixes: ["zv.idempotency/", "zv.checkpoint"],
  },
  4: {
    isCollection: (namespace) => namespace === "zv.collection",
    activeCollection: (_tenant, key) => key.length > 0 ? key : undefined,
    droppedPrefixes: ["zv.idempotency", "zv.checkpoint"],
  },
};

const fail = (message: string, cause?: unknown) => new DataMigrationFailure({ message, ...(cause === undefined ? {} : { cause }) });
const attempt = <A>(message: string, operation: () => A | PromiseLike<A>): Effect.Effect<A, DataMigrationFailure> =>
  integration(operation).pipe(Effect.mapError((error) => fail(`${message} ${error.message}`.trim(), error)));

const runExport = (input: DataMigrationInput, shards: string, out: string) =>
  Effect.callback<void, DataMigrationFailure>((resume) => {
    const child = spawn(input.oldNode, [input.exportWorker, "--platform", input.oldPlatform, "--shards", shards, "--out", out],
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

const decode = (event: ExportedEvent): Record<string, unknown> => JSON.parse(Buffer.from(event.body ?? "", "base64").toString("utf8"));

/** A document as the earlier engine stored it. Every release that wrote layout 2 kept the version and both times. */
interface ExportedDocument {
  readonly id: string;
  readonly collection: string;
  readonly data: Record<string, unknown>;
  readonly version: number | undefined;
  readonly createdAt: string | undefined;
  readonly updatedAt: string | undefined;
  readonly expiresAt: string | undefined;
}
const isVersion = (value: unknown): value is number => isSafeInteger(value) && value >= 1;
const isTime = (value: unknown): value is string => isString(value) && !Number.isNaN(Date.parse(value));
const exportedDocument = objectFields<ExportedDocument>({
  id: isString, collection: isString, data: isJsonObject,
  version: optional(isVersion), createdAt: optional(isTime), updatedAt: optional(isTime), expiresAt: optional(isString),
});

/** What the recreated document is given of the earlier one; a document the earlier engine kept without times inserts fresh. */
const carriedOf = (d: ExportedDocument): CarriedDocument | undefined =>
  typeof d.createdAt === "string" && typeof d.updatedAt === "string"
    ? { version: d.version ?? 1, createdAt: d.createdAt, updatedAt: d.updatedAt }
    : undefined;

/** The fields verification holds a document to; its times only where they were carried. */
interface Comparable {
  readonly data: unknown;
  readonly version: number;
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
  readonly expiresAt?: string | undefined;
}
const comparable = (d: Comparable, timed: boolean) => JSON.stringify({
  data: d.data, version: d.version,
  ...(timed ? { createdAt: d.createdAt, updatedAt: d.updatedAt } : {}),
  expiresAt: typeof d.expiresAt === "string" ? d.expiresAt : null,
});

/** What is live after the whole export, in record order: a later retraction removes the record it names. */
const liveRecords = (events: ReadonlyArray<ExportedEvent>) => {
  const bySeq = new Map<number, ExportedEvent>();
  for (const event of events) {
    if (event.kind === "retract") bySeq.delete(event.seq);
    else bySeq.set(event.seq, event);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
};

export const migrateDataLayout = Effect.fn("DataMigration.migrate")(function* (input: DataMigrationInput): Effect.fn.Return<DataMigrationReport, DataMigrationFailure | IntegrationFailure> {
  const names = SOURCE_NAMES[input.sourceFormat];
  if (names === undefined) return yield* fail(`Data written in layout ${input.sourceFormat} cannot be migrated: this release reads layouts ${Object.keys(SOURCE_NAMES).join(" and ")}. Nothing was changed.`);
  const work = resolve(input.workDirectory), source = join(work, "source"), exported = join(work, "export"), migrated = join(work, "shards");
  const existing = yield* Effect.result(integration(() => stat(work)));
  if (existing._tag === "Success") return yield* fail(`The staging directory ${work} already exists; a migration never reuses one.`);
  const sourceStats = yield* attempt("The data to migrate cannot be read.", () => stat(resolve(input.sourceShards)));
  if (!sourceStats.isDirectory()) return yield* fail("The data to migrate is not a directory.");

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

    const opened = yield* attempt("The migrated database could not be created.", () => openNodeDatabase({ directory: migrated }));
    input.onPhase?.("create the migrated database");
    return yield* Effect.gen(function* () {
      let collections = 0, schemas = 0, documents = 0, historyDropped = 0;
      const dropped: Record<string, number> = {};
      for (const entry of manifest.tenants) {
        const file = join(exported, entry.file);
        const size = (yield* attempt("The export of a Tenant cannot be read.", () => stat(file))).size;
        if (size > MAX_TENANT_FILE_BYTES) return yield* fail(`The export of Tenant "${entry.tenant}" is ${size} bytes, over the ${MAX_TENANT_FILE_BYTES} byte limit.`);
        const tenantSource = yield* attempt("The export of a Tenant cannot be read.", () => readFile(file, "utf8"));
        const exportedTenant = yield* evaluate(() => parseJson(tenantSource, tenantExport, "Data export of a Tenant"));
        const live = liveRecords(exportedTenant.events);
        const tenantDocuments = opened.database.forTenant(entry.tenant).documents;

        const isCollection = (e: ExportedEvent) => e.identity !== undefined && names.isCollection(e.identity.namespace);
        const isSchema = (e: ExportedEvent) => e.identity?.namespace === "zv.schema";
        const isActiveSchema = (e: ExportedEvent) => e.identity?.namespace === "zv.schema.active";
        const isDocument = (e: ExportedEvent) => e.identity?.namespace.startsWith("doc/") === true;
        const unknown: Record<string, number> = {};
        for (const event of live) {
          if (isCollection(event) || isDocument(event) || isSchema(event) || isActiveSchema(event)) continue;
          const namespace = event.identity?.namespace ?? "(no identity)";
          if (names.droppedPrefixes.some((prefix) => namespace.startsWith(prefix))) dropped[namespace.split("/")[0]!] = (dropped[namespace.split("/")[0]!] ?? 0) + 1;
          else unknown[namespace.split("/")[0]!] = (unknown[namespace.split("/")[0]!] ?? 0) + 1;
        }
        if (Object.keys(unknown).length > 0) return yield* fail(`Tenant "${entry.tenant}" holds records this migration cannot recreate yet: ${JSON.stringify(unknown)}. Nothing was changed.`);

        // Collections first, a collection that references another after it.
        const pending = live.filter(isCollection).map((e) => decode(e) as { name: string; references?: Array<{ collection?: string }> } & Record<string, unknown>);
        const created = new Set<string>();
        while (pending.length > 0) {
          const next = pending.findIndex((c) => (c.references ?? []).every((r) => r.collection === undefined || r.collection === c.name || created.has(r.collection)));
          if (next < 0) return yield* fail(`Tenant "${entry.tenant}" has collections whose references cannot be ordered: ${pending.map((c) => c.name).join(", ")}.`);
          const [collection] = pending.splice(next, 1) as [{ name: string } & Record<string, unknown>];
          const definition: Record<string, unknown> = { name: collection.name };
          for (const field of COLLECTION_FIELDS) if (collection[field] !== undefined) definition[field] = collection[field];
          yield* tenantDocuments.createCollection(definition as never).pipe(Effect.mapError((error) => fail(`Collection "${collection.name}" of Tenant "${entry.tenant}" could not be recreated: ${error._tag}.`, error)));
          created.add(collection.name);
          collections += 1;
        }

        const records: ExportedDocument[] = [];
        for (const event of live.filter(isDocument)) {
          records.push(yield* evaluate(() => parseJson(Buffer.from(event.body ?? "", "base64").toString("utf8"), exportedDocument, `Exported document of Tenant "${entry.tenant}"`)));
        }
        const expected = new Map<string, number>();
        for (let at = 0; at < records.length; at += WRITE_BATCH) {
          const batch = records.slice(at, at + WRITE_BATCH);
          const write = {
            operations: batch.map((d) => ({
              _tag: "Insert" as const, collection: d.collection, id: d.id, data: d.data as never,
              ...(typeof d.expiresAt === "string" ? { expiresAt: d.expiresAt } : {}),
            })),
            [CARRY_DOCUMENTS]: batch.map(carriedOf),
          } satisfies CarryDocumentsInput & Record<string, unknown>;
          yield* tenantDocuments.write(write)
            .pipe(Effect.mapError((error) => fail(`Documents of Tenant "${entry.tenant}" could not be recreated: ${error._tag}.`, error)));
          for (const d of batch) { expected.set(d.collection, (expected.get(d.collection) ?? 0) + 1); if ((d.version ?? 1) > 1) historyDropped += 1; }
        }
        documents += records.length;

        // Verification: the recreated Tenant holds exactly the documents the earlier engine exported, with the same data,
        // version, times and expiry.
        const byCollection = new Map<string, Map<string, { readonly expected: string; readonly timed: boolean }>>();
        for (const d of records) {
          const ids = byCollection.get(d.collection) ?? new Map<string, { readonly expected: string; readonly timed: boolean }>();
          const timed = carriedOf(d) !== undefined;
          ids.set(d.id, { expected: comparable({ ...d, version: d.version ?? 1 }, timed), timed });
          byCollection.set(d.collection, ids);
        }
        for (const [collection, ids] of byCollection) {
          const counted = yield* tenantDocuments.count({ collection }).pipe(Effect.mapError((error) => fail(`Collection "${collection}" cannot be counted: ${error._tag}.`, error)));
          if (counted !== ids.size) return yield* fail(`Verification failed for "${entry.tenant}/${collection}": ${ids.size} documents exported, ${counted} recreated.`);
          let after: unknown;
          let seen = 0;
          for (;;) {
            const page = yield* tenantDocuments.findPage({ collection, limit: 1000, ...(after === undefined ? {} : { after: after as never }) })
              .pipe(Effect.mapError((error) => fail(`Collection "${collection}" cannot be read back: ${error._tag}.`, error)));
            for (const document of page.documents) {
              seen += 1;
              const exportedDocument = ids.get(document.id);
              if (exportedDocument === undefined || exportedDocument.expected !== comparable(document, exportedDocument.timed)) return yield* fail(`Verification failed for "${entry.tenant}/${collection}": document "${document.id}" differs after recreation.`);
            }
            if (page.next === undefined) break;
            after = page.next;
          }
          if (seen !== ids.size) return yield* fail(`Verification failed for "${entry.tenant}/${collection}": ${ids.size} documents expected, ${seen} read back.`);
        }

        // Schemas go in last, saved inactive and then activated: an active schema would judge the documents as they come in, and the
        // earlier engine never checked what it already held when a schema was activated.
        const tenantSchemas = opened.database.forTenant(entry.tenant).schemas;
        const savedSchemas = live.filter(isSchema).map((e) => decode(e) as { collection: string; version: number; fields: never });
        for (const schema of savedSchemas.sort((a, b) => a.collection.localeCompare(b.collection) || a.version - b.version)) {
          yield* tenantSchemas.save({ collection: schema.collection, version: schema.version, fields: schema.fields, activate: false })
            .pipe(Effect.mapError((error) => fail(`Schema ${schema.collection}@${schema.version} of Tenant "${entry.tenant}" could not be recreated: ${error._tag}.`, error)));
          schemas += 1;
        }
        for (const record of live.filter(isActiveSchema)) {
          const collection = names.activeCollection(entry.tenant, record.identity?.key ?? "");
          const version = (decode(record) as { version?: number }).version;
          if (collection === undefined || version === undefined) return yield* fail(`Tenant "${entry.tenant}" has an active-schema record this migration cannot read.`);
          yield* tenantSchemas.activate(collection, version)
            .pipe(Effect.mapError((error) => fail(`Schema ${collection}@${version} of Tenant "${entry.tenant}" could not be activated: ${error._tag}.`, error)));
        }
        const readBack = yield* tenantSchemas.listCollections.pipe(Effect.mapError((error) => fail(`Schemas of Tenant "${entry.tenant}" cannot be read back.`, error)));
        if (savedSchemas.length > 0 && readBack.length === 0) return yield* fail(`Verification failed for "${entry.tenant}": its schemas were not found after recreation.`);
      }
      return { shardsDirectory: migrated, tenants: manifest.tenants.length, collections, schemas, documents, documentsWithHistoryDropped: historyDropped, dropped } satisfies DataMigrationReport;
    }).pipe(Effect.ensuring(Effect.promise(() => opened.close()).pipe(Effect.orDie)));
  });

  // Staging this call made is removed on any failure; the source was only ever read.
  return yield* run.pipe(Effect.onError(() => attempt("", () => rm(work, { recursive: true, force: true })).pipe(Effect.orElseSucceed(() => undefined))));
});
