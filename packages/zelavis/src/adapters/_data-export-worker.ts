/**
 * Exports every Tenant of a database with the engine that wrote it.
 *
 * The data-layout migration never reads another engine's storage itself: it runs this file under the OLD engine's own Node,
 * which imports that engine's `zelavis/db` and uses its backup export, then writes the export (`_data-export-format`,
 * format 2) for the current engine to recreate: one NDJSON file per Tenant, a header line and then one line per event of
 * that Tenant's history, in order. The earlier engine's own Effect runtime runs its programs; this file's runtime only
 * sequences them.
 *
 *   node _data-export-worker.js --platform <old release>/platform --shards <copy of its shards> --out <empty directory>
 *
 * A Tenant whose shard log was compacted exports as `state` (one put per live record), any other as `log`.
 *
 * Every export is checked against the earlier engine's own reads before it is written: the released engines read at most
 * one million entries of a whole shard's log for an export and stop there silently, so an export alone cannot be trusted
 * to be complete. Its live collections must be the ones the earlier engine lists, and its live documents the ones the
 * earlier engine reads back, each with the same data, version, times and expiry.
 *
 * Exit 0 writes `manifest.json` last; any other exit leaves no manifest. It refuses (exit 3, a message starting `REFUSED`)
 * a Tenant whose export reaches that cap, differs from the earlier engine's own reads, holds an event it cannot read, or
 * lives on a shard the earlier engine reports no maintenance status for.
 */
import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { arrayOf, isRecord, isSafeInteger, isString, isUnknown, objectFields, parseJson, type JsonValidator } from "../core/json-validation.js";
import { evaluate, integration } from "../core/runtime/effect-boundary.js";
import { comparableDocument, DATA_EXPORT_FORMAT, EXPORT_EVENT_CAP, exportedDocument, exportedEvent, type ExportedEvent, type ExportManifest, type TenantHistory } from "./_data-export-format.js";

interface EarlierEngine {
  readonly database: {
    readonly tenants: unknown;
    readonly shardOf: (tenant: string) => string;
    readonly maintenance: { readonly status: unknown };
    readonly forTenant: (tenant: string) => {
      readonly backups: { readonly exportTenant: unknown };
      readonly documents: {
        readonly listCollections: unknown;
        readonly findPage: (input: { readonly collection: string; readonly limit: number; readonly after?: unknown }) => unknown;
      };
    };
  };
  readonly close: () => Promise<void>;
}

/** What the earlier engine answers, checked before it is relied on: its values cross from another release's code. */
const shardStatus = arrayOf(objectFields<{ readonly shard: string; readonly compactedTo: number }>({ shard: isString, compactedTo: isSafeInteger }));
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
  const earlier = yield* integration(() => import(pathToFileURL(join(platform, "dist", "db", "node-host.js")).href) as Promise<{ openNodeDatabase: (options: { directory: string }) => Promise<EarlierEngine> }>);
  const earlierEffect = yield* integration(() => import(pathToFileURL(join(platform, "node_modules", "effect", "dist", "index.js")).href) as Promise<{ Effect: { runPromise: (program: unknown) => Promise<unknown> } }>);
  const run = (earlierProgram: unknown) => integration(() => earlierEffect.Effect.runPromise(earlierProgram));
  const opened = yield* integration(() => earlier.openNodeDatabase({ directory: shards }));

  /**
   * The export's final state against the earlier engine's own reads: the same collections, and in each the same
   * documents. The first difference refuses.
   */
  const matchesEarlierEngine = (tenant: string, events: ReadonlyArray<ExportedEvent>) => Effect.gen(function* () {
    const incomplete = (what: string) => refuse(`Tenant "${tenant}": its export does not match the earlier engine's own ${what}; the earlier engine reads at most ${EXPORT_EVENT_CAP} log entries per shard for an export, so it is incomplete. Nothing was changed.`);
    const live = new Map<number, ExportedEvent>();
    for (const event of events) {
      if (event.kind === "retract") live.delete(event.seq);
      else live.set(event.seq, event);
    }
    const collectionNamespace = `zv.collection/${tenant}`, documentPrefix = `doc/${tenant}/`;
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

    const documents = opened.database.forTenant(tenant).documents;
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

  const exported = Effect.gen(function* () {
    yield* integration(() => mkdir(out, { recursive: true }));
    const tenants = yield* answered(yield* run(opened.database.tenants), arrayOf(isString), "its Tenants");
    const status = yield* answered(yield* run(opened.database.maintenance.status), shardStatus, "its maintenance status");
    const files: Array<ExportManifest["tenants"][number]> = [];
    for (const [index, tenant] of tenants.entries()) {
      const backup = yield* answered(yield* run(opened.database.forTenant(tenant).backups.exportTenant), tenantBackup, `the export of Tenant "${tenant}"`);
      if (backup.events.length >= EXPORT_EVENT_CAP) {
        return yield* refuse(`Tenant "${tenant}" exported ${backup.events.length} events, which reaches the released engine's export cap; its export may be truncated.`);
      }
      const events: Array<ExportedEvent> = [];
      for (const raw of backup.events) {
        // Only what the format names is kept; the earlier engine's lens manifest names its own index keys.
        const { kind, seq, version, at, identity, body } = isRecord(raw) ? raw : {};
        const event = {
          kind, seq, version, at,
          ...(identity === undefined ? {} : { identity }), ...(body === undefined ? {} : { body }),
        };
        if (!exportedEvent(event)) return yield* refuse(`Tenant "${tenant}": its export holds an event this migration cannot read (seq ${String(seq)}).`);
        events.push(event);
      }
      const shard = opened.database.shardOf(tenant);
      const entry = status.find((candidate) => candidate.shard === shard);
      if (entry === undefined) return yield* refuse(`Tenant "${tenant}": its shard has no maintenance status.`);
      const history: TenantHistory = entry.compactedTo > 0 ? "state" : "log";
      yield* matchesEarlierEngine(tenant, events);

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
    yield* integration(() => writeFile(join(out, "manifest.json"), JSON.stringify({ format: DATA_EXPORT_FORMAT, tenants: files } satisfies ExportManifest)));
  });
  yield* exported.pipe(Effect.ensuring(integration(() => opened.close()).pipe(Effect.orDie)));
});

Effect.runFork(program.pipe(
  Effect.catch((error) => Effect.sync(() => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.message.startsWith("REFUSED") ? 3 : 1;
  })),
));
