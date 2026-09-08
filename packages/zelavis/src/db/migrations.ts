import { Effect } from "effect";
import type { DocumentsApi } from "./documents.js";
import { SchemaMigrationBlocked, SchemaNotFound } from "./errors.js";
import type { Json, JsonObject } from "./json.js";
import type { SchemasApi } from "./schemas.js";
import {
  validateDocumentData,
  type CollectionFieldEntry,
  type SchemaValidationIssue,
} from "./schema/index.js";
import type { TenantId } from "./topology.js";

/**
 * Bringing documents forward from one schema version to another.
 *
 * Activating a version changes what is accepted from that moment on and leaves
 * everything already written exactly as it was. That is the right default —
 * a schema change should never silently rewrite data — but it means a
 * collection can hold documents the active schema would refuse, and validation
 * rejects unknown keys, so removing a single field is enough to put every
 * existing document out of step.
 *
 * Migration is the deliberate other half. Two things shape it:
 *
 * Instructions are data, not functions. A closure could express any
 * transformation and could not be inspected, logged, reviewed before running,
 * or sent anywhere — the same reason a query here is a value. What the
 * instructions cannot express, a caller does by reading and writing documents
 * itself, which is honest about being a bespoke operation.
 *
 * Saving a version activates it unless told otherwise, so a version meant to be
 * migrated into is saved with `activate: false` and activated by the migration
 * once the documents are in a shape it accepts.
 *
 * The decision is all-or-nothing even though the writes are not. Every document
 * is transformed and checked against the new version *before* anything is
 * activated or written, so a migration that would leave some documents invalid
 * refuses rather than getting halfway. The writes that follow are one per
 * document, and re-running is safe: every instruction is idempotent, so an
 * interrupted migration is finished by asking for it again.
 */

/** One change to make to each document. */
export type FieldMigration =
  /** Move a value to a new name, if the old name is still there. */
  | { readonly _tag: "Rename"; readonly from: string; readonly to: string }
  /** Write a value, whatever was there. */
  | { readonly _tag: "Set"; readonly path: string; readonly value: Json }
  /** Write a value only where the field is missing. */
  | { readonly _tag: "Default"; readonly path: string; readonly value: Json }
  /** Remove a field. */
  | { readonly _tag: "Drop"; readonly path: string };

export const renameField = (from: string, to: string): FieldMigration =>
  ({ _tag: "Rename", from, to });
export const setField = (path: string, value: Json): FieldMigration =>
  ({ _tag: "Set", path, value });
export const defaultField = (path: string, value: Json): FieldMigration =>
  ({ _tag: "Default", path, value });
export const dropField = (path: string): FieldMigration => ({ _tag: "Drop", path });

export interface SchemaDifference {
  readonly path: string;
  readonly change: "added" | "removed" | "retyped" | "tightened";
  readonly detail: string;
  /**
   * Whether an instruction is needed.
   *
   * A removal is not: a field the new version does not have is discarded,
   * because validation rejects unknown keys and there is nothing else it could
   * mean. Everything else is the caller's call — only they know whether a new
   * required field should be filled with a constant, carried over from an old
   * name, or derived some way this cannot express.
   */
  readonly blocking: boolean;
}

export interface MigrationPlan {
  readonly collection: string;
  readonly from: number;
  readonly to: number;
  readonly differences: ReadonlyArray<SchemaDifference>;
  /** Blocking differences no supplied instruction covers. */
  readonly unresolved: ReadonlyArray<SchemaDifference>;
  /** Fields that will be discarded, named so that is visible before it happens. */
  readonly discards: ReadonlyArray<string>;
  readonly documents: number;
}

export interface MigrationFailure {
  readonly id: string;
  readonly issues: ReadonlyArray<SchemaValidationIssue>;
}

export interface MigrationResult {
  readonly collection: string;
  readonly from: number;
  readonly to: number;
  /** Documents whose data changed and were written. */
  readonly migrated: number;
  /** Documents already satisfying the new version, left alone. */
  readonly unchanged: number;
  /** Documents that would still be invalid. Non-empty means nothing was done. */
  readonly failures: ReadonlyArray<MigrationFailure>;
  readonly activated: boolean;
  readonly dryRun: boolean;
}

export interface MigrateInput {
  /** The version to migrate from. Defaults to the active one. */
  readonly from?: number;
  readonly to: number;
  readonly apply?: ReadonlyArray<FieldMigration>;
  /** Work out the answer and change nothing. */
  readonly dryRun?: boolean;
  /**
   * Leave the new version inactive.
   *
   * Rarely what you want: the documents are then written in a shape the active
   * version rejects, so the next update to any of them fails.
   */
  readonly activate?: boolean;
}

export interface MigrationsApi {
  /** What separates two versions, and what a caller would still have to say. */
  readonly plan: (
    collection: string,
    input: { readonly from?: number; readonly to: number;
      readonly apply?: ReadonlyArray<FieldMigration> },
  ) => Effect.Effect<MigrationPlan, SchemaNotFound>;

  /**
   * Bring every document in a collection up to a version.
   *
   * Refuses before changing anything when the plan has unresolved differences,
   * or when any document would still be invalid afterwards.
   */
  readonly migrate: (
    collection: string,
    input: MigrateInput,
  ) => Effect.Effect<MigrationResult, SchemaNotFound | SchemaMigrationBlocked>;
}

const typeOf = (entry: CollectionFieldEntry) => entry.field._tag;

/** Apply the instructions to one document's data, then discard what is unknown. */
const transform = (
  data: JsonObject,
  instructions: ReadonlyArray<FieldMigration>,
  keep: ReadonlySet<string>,
): JsonObject => {
  const out: Record<string, Json> = { ...data };
  for (const step of instructions) {
    switch (step._tag) {
      case "Rename":
        // Only when the old name is still there, so re-running a finished
        // migration does not undo it by renaming an absent field over the new
        // one.
        if (Object.hasOwn(out, step.from)) {
          out[step.to] = out[step.from]!;
          delete out[step.from];
        }
        break;
      case "Set":
        out[step.path] = step.value;
        break;
      case "Default":
        if (!Object.hasOwn(out, step.path)) out[step.path] = step.value;
        break;
      case "Drop":
        delete out[step.path];
        break;
    }
  }
  // Validation rejects unknown keys, so anything the new version does not name
  // has to go. Done last, so an instruction may move a value out of a field
  // that is about to be discarded.
  for (const key of Object.keys(out)) {
    if (!keep.has(key)) delete out[key];
  }
  return out as JsonObject;
};

export const migrationsFor = (
  documents: DocumentsApi,
  schemas: SchemasApi,
  tenant: TenantId,
): MigrationsApi => {
  const versions = (collection: string, from: number | undefined, to: number) =>
    Effect.gen(function* () {
      const target = yield* schemas.getVersion(collection, to);
      if (target === undefined) {
        return yield* new SchemaNotFound({ collection, version: to });
      }
      const active = yield* schemas.getActive(collection);
      const sourceVersion = from ?? active?.version;
      if (sourceVersion === undefined) {
        // Nothing is active and none was named, so there is no "before" to
        // compare against — which is a caller mistake rather than an empty
        // difference, because migrating from nothing would silently discard
        // every field the new version does not happen to name.
        return yield* new SchemaNotFound({ collection, version: 0 });
      }
      const source = yield* schemas.getVersion(collection, sourceVersion);
      if (source === undefined) {
        return yield* new SchemaNotFound({ collection, version: sourceVersion });
      }
      return { source, target };
    });

  const differencesBetween = (
    source: ReadonlyArray<CollectionFieldEntry>,
    target: ReadonlyArray<CollectionFieldEntry>,
  ): ReadonlyArray<SchemaDifference> => {
    const before = new Map(source.map((entry) => [entry.name, entry]));
    const after = new Map(target.map((entry) => [entry.name, entry]));
    const out: SchemaDifference[] = [];

    for (const [name, entry] of after) {
      const was = before.get(name);
      if (was === undefined) {
        out.push({
          path: name,
          change: "added",
          detail: `${typeOf(entry)}${entry.field.required ? ", required" : ", optional"}`,
          // An optional new field needs nothing: a document without it is
          // valid as it stands.
          blocking: entry.field.required,
        });
        continue;
      }
      if (typeOf(was) !== typeOf(entry)) {
        out.push({
          path: name,
          change: "retyped",
          detail: `${typeOf(was)} to ${typeOf(entry)}`,
          blocking: true,
        });
        continue;
      }
      if (!was.field.required && entry.field.required) {
        out.push({
          path: name,
          change: "tightened",
          detail: "optional to required",
          blocking: true,
        });
      }
    }

    for (const [name, entry] of before) {
      if (after.has(name)) continue;
      out.push({
        path: name,
        change: "removed",
        detail: `${typeOf(entry)}, discarded`,
        blocking: false,
      });
    }

    return out;
  };

  /** Which blocking differences an instruction set speaks to. */
  const unresolvedIn = (
    differences: ReadonlyArray<SchemaDifference>,
    instructions: ReadonlyArray<FieldMigration>,
  ) => {
    const addressed = new Set<string>();
    for (const step of instructions) {
      addressed.add(step._tag === "Rename" ? step.to : step.path);
    }
    return differences.filter((d) => d.blocking && !addressed.has(d.path));
  };

  const prepare = (
    collection: string,
    input: { from?: number; to: number; apply?: ReadonlyArray<FieldMigration> },
  ) =>
    Effect.gen(function* () {
      const { source, target } = yield* versions(collection, input.from, input.to);
      const instructions = input.apply ?? [];
      const differences = differencesBetween(source.fields, target.fields);
      const keep = new Set(target.fields.map((entry) => entry.name));
      const docs = yield* documents.findMany({ collection });
      return {
        source,
        target,
        instructions,
        differences,
        keep,
        docs,
        unresolved: unresolvedIn(differences, instructions),
        discards: differences.filter((d) => d.change === "removed").map((d) => d.path),
      };
    });

  return {
    plan: (collection, input) =>
      Effect.map(prepare(collection, input), (ready) => ({
        collection,
        from: ready.source.version,
        to: ready.target.version,
        differences: ready.differences,
        unresolved: ready.unresolved,
        discards: ready.discards,
        documents: ready.docs.length,
      })),

    migrate: (collection, input) =>
      Effect.gen(function* () {
        const ready = yield* prepare(collection, input);
        if (ready.unresolved.length > 0) {
          return yield* new SchemaMigrationBlocked({
            tenant,
            collection,
            from: ready.source.version,
            to: ready.target.version,
            unresolved: ready.unresolved.map((d) => `${d.path}: ${d.change} (${d.detail})`),
          });
        }

        // Everything is transformed and checked before anything is activated or
        // written. A migration that would leave documents invalid is one to
        // refuse, not one to get halfway through.
        const pending: Array<{ id: string; data: JsonObject }> = [];
        const failures: MigrationFailure[] = [];
        let unchanged = 0;

        for (const doc of ready.docs) {
          const next = transform(doc.data, ready.instructions, ready.keep);
          const check = validateDocumentData(ready.target.fields, next);
          if (!check.valid) {
            failures.push({ id: doc.id, issues: check.issues });
            continue;
          }
          if (JSON.stringify(next) === JSON.stringify(doc.data)) unchanged += 1;
          else pending.push({ id: doc.id, data: next });
        }

        const dryRun = input.dryRun === true;
        const common = {
          collection,
          from: ready.source.version,
          to: ready.target.version,
          unchanged,
          failures,
          dryRun,
        };
        if (failures.length > 0) {
          return { ...common, migrated: 0, activated: false };
        }
        if (dryRun) {
          return { ...common, migrated: pending.length, activated: false };
        }

        // Activated first, because a document write validates against whatever
        // is active: writing the new shape while the old version is still in
        // force would be refused by the very check this exists to satisfy.
        const activate = input.activate !== false;
        if (activate) yield* schemas.activate(collection, ready.target.version);

        for (const { id, data } of pending) {
          yield* documents.update({ collection, id, data, mode: "replace" }).pipe(Effect.orDie);
        }

        return { ...common, migrated: pending.length, activated: activate };
      }),
  };
};
