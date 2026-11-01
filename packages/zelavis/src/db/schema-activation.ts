/**
 * Activating a schema version: a durable workflow, not a pointer flip.
 *
 * A version implies lens declarations (`deriveDeclarations`), and documents
 * already stored must be re-derived under them before the version may govern
 * anything. So activation runs in three steps:
 *
 * 1. Record the intent (`zv.schema.activation/<collection>`), in its own commit.
 * 2. Apply the declarations to the collection and backfill every document's
 *    postings (`documents.declareFromSchema`), which also validates them
 *    against what is stored: a vector the derived embedding does not admit
 *    refuses the activation and puts the previous declarations back.
 * 3. Publish: in one transaction, point the collection at the version and
 *    retract the intent — but only while the intent still names this version
 *    and the collection still carries this version's declarations. A
 *    concurrent activation that overtook this one leaves it refused rather
 *    than publishing a version whose declarations were replaced.
 *
 * A crash leaves the intent standing, and `resumeActivations` (run when the
 * database opens) runs the same activation again: every step is idempotent,
 * so a resumed activation ends where an uninterrupted one would have.
 */
import { Effect, Stream } from "effect";
import { isPositiveInteger, isString, objectFields, parseJson } from "../core/json-validation.js";
import { SchemaActivationRefused, SchemaNotFound, type SchemaVersionExists, type TenantMoving } from "./errors.js";
import type { DocumentsApi } from "./document-model.js";
import { collectionNs, collectionRecord, decode } from "./document-records.js";
import { equals } from "./query.js";
import { ACTIVE_NS, activeKey, type SchemaRecords } from "./schemas.js";
import type { ObjectStoreApi } from "./store.js";
import type { TenantId } from "./topology.js";
import { deriveDeclarations, type SkippedDeclaration } from "./schema/semantics.js";
import { schemaTransferFor, type SchemaTransferApi } from "./schema-transfer.js";
import type { CollectionSchema, StoredCollectionSchema } from "./schema/index.js";
import type { DerivedDeclarationSet } from "./document-model.js";

const INTENT_NS = "zv.schema.activation";
/** Lists a tenant's standing intents, so resuming reads only them. */
const INTENT_COLUMN = "zv.schema.activation";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** An activation recorded and not yet published. */
export interface PendingActivation {
  readonly collection: string;
  readonly version: number;
  readonly startedAt: string;
}

/** What activating a version did to its collection: null when the collection does not exist yet. */
export interface ActivationReport {
  readonly applied: DerivedDeclarationSet;
  readonly skipped: ReadonlyArray<SkippedDeclaration>;
  /** Documents whose postings were re-derived. */
  readonly documents: number;
}

export type ActivatedSchema = StoredCollectionSchema & { readonly activation: ActivationReport | null };

export interface SchemasApi extends Omit<SchemaRecords, "save">, SchemaTransferApi {
  /** Store a version; unless `activate` is false, activate it as `activate` does. */
  readonly save: (
    schema: CollectionSchema,
  ) => Effect.Effect<
    StoredCollectionSchema | ActivatedSchema,
    SchemaVersionExists | SchemaNotFound | SchemaActivationRefused | TenantMoving
  >;
  /**
   * Make a version the one that governs writes, once the declarations it
   * implies are applied and every stored document re-derived under them.
   */
  readonly activate: (
    collection: string,
    version: number,
  ) => Effect.Effect<ActivatedSchema, SchemaNotFound | SchemaActivationRefused | TenantMoving>;
  /** Activations recorded and not yet published: interrupted, or still running. */
  readonly pendingActivations: Effect.Effect<ReadonlyArray<PendingActivation>>;
  /**
   * Run every pending activation again, returning how many were published.
   * One that is refused now has its intent retracted and is logged.
   */
  readonly resumeActivations: Effect.Effect<number>;
}

const intentRecord = objectFields<PendingActivation>({
  collection: isString, version: isPositiveInteger, startedAt: isString,
});

/** How often a publish may find its declarations replaced and apply them again. */
const MAX_REDECLARES = 3;

export const activationFor = (
  store: ObjectStoreApi,
  tenant: TenantId,
  records: SchemaRecords,
  documents: DocumentsApi,
): SchemasApi => {
  const readIntent = (collection: string) =>
    Effect.gen(function* () {
      const seq = yield* store.lookup(INTENT_NS, collection);
      if (seq === undefined) return undefined;
      const object = yield* store.read(seq);
      return object === undefined ? undefined : { seq, intent: parseJson(dec.decode(object.bytes), intentRecord, "schema activation") };
    });

  const recordIntent = (intent: PendingActivation) =>
    Effect.gen(function* () {
      const seq = (yield* store.lookup(INTENT_NS, intent.collection)) ?? (yield* store.nextSeq);
      yield* store.transact((txn) =>
        txn.put(seq, enc.encode(JSON.stringify(intent)), {
          terms: [], columns: [[INTENT_COLUMN, tenant]], measures: [], edges: [],
        }, { namespace: INTENT_NS, key: intent.collection }));
    }).pipe(Effect.orDie);

  /** Retract the intent, if it still names this version: a newer one is another activation's. */
  const retractIntent = (collection: string, version: number) =>
    store.transact((txn) =>
      Effect.gen(function* () {
        const held = yield* readIntent(collection);
        if (held !== undefined && held.intent.version === version) yield* txn.retract(held.seq);
      })).pipe(Effect.orDie);

  /**
   * Point the collection at the version and retract the intent, in one
   * transaction, checking inside it what makes publishing right.
   */
  const publish = (collection: string, version: number) =>
    Effect.gen(function* () {
      const activeSeq = (yield* store.lookup(ACTIVE_NS, activeKey(collection))) ?? (yield* store.nextSeq);
      return yield* store.transact((txn) =>
        Effect.gen(function* () {
          const held = yield* readIntent(collection);
          if (held === undefined || held.intent.version !== version) return "superseded" as const;
          const collectionSeq = yield* store.lookup(collectionNs(), collection);
          if (collectionSeq !== undefined) {
            const object = yield* store.read(collectionSeq);
            const stored = object === undefined ? undefined : decode(object.bytes, collectionRecord);
            if (stored !== undefined && stored.derived?.schemaVersion !== version) return "redeclare" as const;
          }
          yield* txn.put(activeSeq, enc.encode(JSON.stringify({ version })), {
            terms: [], columns: [], measures: [], edges: [],
          }, { namespace: ACTIVE_NS, key: activeKey(collection) });
          yield* txn.retract(held.seq);
          return "published" as const;
        }));
    }).pipe(Effect.orDie);

  const refuse = (collection: string, version: number, reason: string) =>
    Effect.andThen(retractIntent(collection, version), Effect.fail(new SchemaActivationRefused({ collection, version, reason })));

  /** Steps 2 and 3, for an intent already recorded. */
  const run = (stored: StoredCollectionSchema) =>
    Effect.gen(function* () {
      const { collection, version } = stored;
      const derived = deriveDeclarations(version, stored.fields);
      const { skipped: unsafe, ...declarations } = derived;
      let report: ActivationReport | null = null;
      for (let attempt = 0; attempt <= MAX_REDECLARES; attempt++) {
        if (yield* documents.collectionExists(collection)) {
          const declared = yield* documents.declareFromSchema({ collection, declarations }).pipe(
            Effect.map((result): ActivationReport => ({ ...result, skipped: [...unsafe, ...result.skipped] })),
            Effect.catchTags({
              // Dropped meanwhile: there is nothing left to declare on.
              CollectionNotFound: () => Effect.succeed(null),
              InvalidConstraint: (error) => refuse(collection, version, error.reason),
              VectorShapeMismatch: (error) =>
                refuse(collection, version, `document "${error.id}" ${error.reason}`),
            }),
          );
          report = declared;
        } else report = null;
        const outcome = yield* publish(collection, version);
        if (outcome === "published") return { ...stored, active: true, activation: report } satisfies ActivatedSchema;
        if (outcome === "superseded") {
          return yield* new SchemaActivationRefused({
            collection, version, reason: "another activation of this collection started after this one",
          });
        }
      }
      return yield* refuse(collection, version, "the collection's declarations kept changing while it was activated");
    });

  const activate = (collection: string, version: number) =>
    Effect.gen(function* () {
      const stored = yield* records.getVersion(collection, version);
      if (stored === undefined) return yield* new SchemaNotFound({ collection, version });
      yield* recordIntent({ collection, version, startedAt: new Date().toISOString() });
      return yield* run(stored);
    });

  const pendingActivations = Effect.gen(function* () {
    const out: Array<PendingActivation> = [];
    for (const seq of yield* Stream.runCollect(store.resolve(equals(INTENT_COLUMN, tenant)))) {
      const object = yield* store.read(seq);
      if (object !== undefined) out.push(parseJson(dec.decode(object.bytes), intentRecord, "schema activation"));
    }
    return out.sort((a, b) => (a.collection < b.collection ? -1 : a.collection > b.collection ? 1 : 0));
  }).pipe(Effect.orDie);

  return {
    ...schemaTransferFor(records, activate),
    listCollections: records.listCollections,
    listVersions: records.listVersions,
    getVersion: records.getVersion,
    getActive: records.getActive,
    validate: records.validate,
    save: (schema) =>
      Effect.gen(function* () {
        const stored = yield* records.save(schema);
        if (schema.activate === false) return stored;
        return yield* activate(stored.collection, stored.version);
      }),
    activate,
    pendingActivations,
    resumeActivations: Effect.gen(function* () {
      let published = 0;
      for (const pending of yield* pendingActivations) {
        const stored = yield* records.getVersion(pending.collection, pending.version);
        if (stored === undefined) {
          yield* retractIntent(pending.collection, pending.version);
          continue;
        }
        yield* run(stored).pipe(
          Effect.andThen(Effect.sync(() => { published += 1; })),
          Effect.catchCause((cause) =>
            Effect.logWarning(`Activation of schema v${pending.version} of "${pending.collection}" not resumed`, cause)),
        );
      }
      return published;
    }),
  } satisfies SchemasApi;
};

