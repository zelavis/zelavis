import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Data, Effect } from "effect";
import { evaluate, integration, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { arrayOf, isSafeInteger, isString, literal, objectFields, optional, parseJson } from "../core/json-validation.js";
import { openNodeDatabase } from "../db/node-host.js";

/**
 * Brings a database written by an earlier release forward to the layout this build writes.
 *
 * The earlier release's own engine exports every Tenant (`_data-export-worker`), and the records are recreated here through
 * the documents API, the only door that derives the lenses itself. A backup restore does not do this: the earlier layout named
 * records and their index entries by tenant, so a restored record would be stored but invisible. Document ids and data survive.
 * Document versions, history and timestamps restart, and event positions are new; the caller reports that.
 *
 * It only reads the source and writes under `workDirectory`, so a failure leaves the source exactly as it was and removes
 * the staging it made. Swapping the result in, and keeping the old data, belong to the caller.
 */
export class DataMigrationFailure extends Data.TaggedError("DataMigrationFailure")<{ readonly message: string; readonly cause?: unknown }> {}

export interface DataMigrationInput {
  /** The earlier layout's shard directory. Copied, never opened in place. */
  readonly sourceShards: string;
  /** Must not exist yet; the staging and the migrated shards live here. */
  readonly workDirectory: string;
  /** The earlier release's private Node and the `platform` directory of its release tree. */
  readonly oldNode: string;
  readonly oldPlatform: string;
  /** The compiled `_data-export-worker.js`. */
  readonly exportWorker: string;
  readonly exportTimeoutMs?: number;
}

export interface DataMigrationReport {
  readonly shardsDirectory: string;
  readonly tenants: number;
  readonly collections: number;
  readonly documents: number;
  /** Documents that had been updated or were already at a later version; their versions restart at one. */
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
const WRITE_BATCH = 500;
const MAX_TENANT_FILE_BYTES = 512 * 1024 * 1024;
/** Held by the earlier engine per Tenant and rebuilt or short-lived here: idempotency receipts and projection checkpoints. */
const DROPPED_PREFIXES = ["zv.idempotency/", "zv.checkpoint"];
const COLLECTION_FIELDS = ["surface", "metadata", "indexes", "checks", "references", "analyzer", "spatial", "embedding", "edges", "measures"] as const;

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
  const work = resolve(input.workDirectory), source = join(work, "source"), exported = join(work, "export"), migrated = join(work, "shards");
  const existing = yield* Effect.result(integration(() => stat(work)));
  if (existing._tag === "Success") return yield* fail(`The staging directory ${work} already exists; a migration never reuses one.`);
  const sourceStats = yield* attempt("The data to migrate cannot be read.", () => stat(resolve(input.sourceShards)));
  if (!sourceStats.isDirectory()) return yield* fail("The data to migrate is not a directory.");

  const run = Effect.gen(function* () {
    yield* attempt("The staging directory could not be created.", () => mkdir(work, { recursive: true, mode: 0o700 }));
    yield* attempt("The data could not be copied for export.", () => cp(resolve(input.sourceShards), source, { recursive: true }));
    yield* runExport(input, source, exported);
    const manifestSource = yield* attempt("The export is incomplete.", () => readFile(join(exported, "manifest.json"), "utf8"));
    const manifest = yield* evaluate(() => parseJson(manifestSource, exportManifest, "Data export manifest"));

    const opened = yield* attempt("The migrated database could not be created.", () => openNodeDatabase({ directory: migrated }));
    return yield* Effect.gen(function* () {
      let collections = 0, documents = 0, historyDropped = 0;
      const dropped: Record<string, number> = {};
      for (const entry of manifest.tenants) {
        const file = join(exported, entry.file);
        const size = (yield* attempt("The export of a Tenant cannot be read.", () => stat(file))).size;
        if (size > MAX_TENANT_FILE_BYTES) return yield* fail(`The export of Tenant "${entry.tenant}" is ${size} bytes, over the ${MAX_TENANT_FILE_BYTES} byte limit.`);
        const tenantSource = yield* attempt("The export of a Tenant cannot be read.", () => readFile(file, "utf8"));
        const exportedTenant = yield* evaluate(() => parseJson(tenantSource, tenantExport, "Data export of a Tenant"));
        const live = liveRecords(exportedTenant.events);
        const tenantDocuments = opened.database.forTenant(entry.tenant).documents;

        const isCollection = (e: ExportedEvent) => e.identity?.namespace.startsWith("zv.collection/") === true;
        const isDocument = (e: ExportedEvent) => e.identity?.namespace.startsWith("doc/") === true;
        const unknown: Record<string, number> = {};
        for (const event of live) {
          if (isCollection(event) || isDocument(event)) continue;
          const namespace = event.identity?.namespace ?? "(no identity)";
          if (DROPPED_PREFIXES.some((prefix) => namespace.startsWith(prefix))) dropped[namespace.split("/")[0]!] = (dropped[namespace.split("/")[0]!] ?? 0) + 1;
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

        const records = live.filter(isDocument).map((e) => decode(e) as { id: string; collection: string; data: Record<string, unknown>; version?: number });
        const expected = new Map<string, number>();
        for (let at = 0; at < records.length; at += WRITE_BATCH) {
          const batch = records.slice(at, at + WRITE_BATCH);
          yield* tenantDocuments.write({ operations: batch.map((d) => ({ _tag: "Insert" as const, collection: d.collection, id: d.id, data: d.data as never })) })
            .pipe(Effect.mapError((error) => fail(`Documents of Tenant "${entry.tenant}" could not be recreated: ${error._tag}.`, error)));
          for (const d of batch) { expected.set(d.collection, (expected.get(d.collection) ?? 0) + 1); if ((d.version ?? 1) > 1) historyDropped += 1; }
        }
        documents += records.length;

        // Verification: the recreated Tenant holds exactly the documents the earlier engine exported, with the same data.
        const byCollection = new Map<string, Map<string, string>>();
        for (const d of records) {
          const ids = byCollection.get(d.collection) ?? new Map<string, string>();
          ids.set(d.id, JSON.stringify(d.data));
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
              if (ids.get(document.id) !== JSON.stringify(document.data)) return yield* fail(`Verification failed for "${entry.tenant}/${collection}": document "${document.id}" differs after recreation.`);
            }
            if (page.next === undefined) break;
            after = page.next;
          }
          if (seen !== ids.size) return yield* fail(`Verification failed for "${entry.tenant}/${collection}": ${ids.size} documents expected, ${seen} read back.`);
        }
      }
      return { shardsDirectory: migrated, tenants: manifest.tenants.length, collections, documents, documentsWithHistoryDropped: historyDropped, dropped } satisfies DataMigrationReport;
    }).pipe(Effect.ensuring(Effect.promise(() => opened.close()).pipe(Effect.orDie)));
  });

  // Staging this call made is removed on any failure; the source was only ever read.
  return yield* run.pipe(Effect.onError(() => attempt("", () => rm(work, { recursive: true, force: true })).pipe(Effect.orElseSucceed(() => undefined))));
});
