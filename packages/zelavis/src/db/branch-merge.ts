/**
 * Merging a branch back into the Tenant it was branched from, as decided in
 * `.agents/references/branch-merge-decision.md`.
 *
 * A branch and its source share one log up to the branch point and diverge
 * after it. What each side changed is read from its own log after that point,
 * by document identity (collection and id) rather than by internal identifier:
 * both sides hand out identifiers after the branch point, so the same number
 * names different records on each. A document only the branch changed is
 * applied to the source; one only the source changed stays; one both changed
 * to the same state is left; one both changed differently is a conflict, and
 * there is no default winner. A conflict is settled only by the caller naming
 * the side to keep. With any conflict unsettled nothing is written, and the
 * answer is the plan — which is also what `dryRun` returns.
 *
 * Writes go through the source's own documents API in batches, each checked
 * against the version the plan read (`expectedVersion`), so a source written
 * meanwhile refuses the batch rather than being overwritten, and every check,
 * unique value and reference of the source holds. A merge cut off part way is
 * run again: a document already carrying the branch's state is "the same on
 * both sides" and is left, so nothing is applied twice.
 *
 * Collections the branch created are created in the source first. A
 * collection whose definition differs between the sides is a conflict too,
 * settled only by keeping the source's definition (documents are then merged
 * under it). Records outside documents and collections (key-value entries,
 * outbox messages, schema versions, series state) are not merged; their
 * namespaces are reported in `unmerged` so nothing is lost silently.
 */
import { Effect, Stream } from "effect";
import type { DocumentsApi, DocumentWrite, Collection } from "./document-model.js";
import { BranchNotMergeable, type DbError } from "./errors.js";
import type { EventCursor } from "./events.js";
import type { ObjectIdentity, Seq } from "./model.js";
import type { ObjectStoreApi } from "./store.js";
import {
  CHECKPOINT_NAMESPACE, COLLECTION_NAMESPACE, DOCUMENT_NAMESPACE_PREFIX, IDEMPOTENCY_NAMESPACE, TIME_SERIES_STATE_NAMESPACE,
} from "./tenancy.js";

/** Records a branch's own writes leave that are derived or bookkeeping, not state to merge. */
const DERIVED = new Set([IDEMPOTENCY_NAMESPACE, CHECKPOINT_NAMESPACE, TIME_SERIES_STATE_NAMESPACE, "zv.timeseries"]);

export interface MergeResolution {
  readonly collection: string;
  /** A document; without it, the collection's definition. */
  readonly id?: string;
  readonly keep: "source" | "branch";
}

export interface MergeOptions {
  /** The Tenant to merge into; the branch's source when omitted, and refused when it is not. */
  readonly into?: string;
  /** Plan only: write nothing. */
  readonly dryRun?: boolean;
  readonly resolve?: ReadonlyArray<MergeResolution>;
}

export interface MergeConflict {
  readonly kind: "document" | "collection";
  readonly collection: string;
  readonly id?: string;
  /** The source's and the branch's current state: a version, or absent. */
  readonly source?: number;
  readonly branch?: number;
}

export interface PartitionMerge {
  readonly part?: string;
  /** The position both logs share. */
  readonly branchPoint: number;
  /** Documents the merge writes (or would write) into the source, and collections it creates. */
  readonly writes: number;
  readonly deletes: number;
  readonly created: ReadonlyArray<string>;
  /** The first thousand; `conflictCount` is all. */
  readonly conflicts: ReadonlyArray<MergeConflict>;
  readonly conflictCount: number;
  /** Namespaces the branch changed that a merge does not carry. */
  readonly unmerged: ReadonlyArray<string>;
}

export interface BranchMerge {
  readonly branch: string;
  readonly into: string;
  readonly dryRun: boolean;
  /** Written: no conflict was left unsettled and this was not a dry run. */
  readonly merged: boolean;
  readonly writes: number;
  readonly deletes: number;
  readonly conflictCount: number;
  readonly partitions: ReadonlyArray<PartitionMerge>;
}

const EVENTS_BATCH = 512;
const WRITE_BATCH = 250;
const MAX_CHANGES = 200_000;
const MAX_REPORTED = 1000;

interface Side {
  readonly store: ObjectStoreApi;
  readonly documents: DocumentsApi;
}

interface Changes {
  /** `collection\u0000id` of every document changed after the branch point. */
  readonly documents: Set<string>;
  readonly collections: Set<string>;
  readonly other: Set<string>;
}

const documentKey = (collection: string, id: string) => `${collection}\u0000${id}`;

const canonical = (value: unknown): string =>
  Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
      : JSON.stringify(value);

/** A collection's definition, without what differs merely by when or where it was made. */
const definitionOf = (collection: Collection | undefined): string | undefined => {
  if (collection === undefined) return undefined;
  const { createdAt: _createdAt, derived: _derived, indexes, ...rest } = collection as Collection & { readonly derived?: unknown };
  return canonical({ ...rest, indexes: (indexes ?? []).map(({ state: _state, ...index }) => index) });
};

export const mergePartition = (
  input: {
    readonly branch: Side;
    readonly source: Side;
    readonly branchPoint: number;
    readonly resolve: ReadonlyArray<MergeResolution>;
    readonly dryRun: boolean;
    readonly part?: string;
    readonly refuse: (reason: string) => BranchNotMergeable;
  },
): Effect.Effect<PartitionMerge & { readonly settled: boolean }, DbError | BranchNotMergeable | Effect.Error<ReturnType<DocumentsApi["write"]>> | Effect.Error<ReturnType<DocumentsApi["createCollection"]>>> =>
  Effect.gen(function* () {
    const { branch, source, branchPoint } = input;

    /** The identity a record from before the branch point has, read from whichever side still holds it. */
    const sharedIdentity = (seq: Seq) =>
      Effect.gen(function* () {
        for (const side of [source, branch]) {
          const [found] = yield* side.store.scanRecords({ after: (seq - 1) as Seq, limit: 1 });
          if (found !== undefined && found.seq === seq && found.record.live) return found.record.identity;
        }
        // Removed on both sides: both are the same, and nothing is merged.
        return undefined;
      });

    const changesOf = (side: Side) =>
      Effect.gen(function* () {
        const changes: Changes = { documents: new Set(), collections: new Set(), other: new Set() };
        const identities = new Map<number, ObjectIdentity>();
        const note = (identity: ObjectIdentity | undefined) => {
          if (identity === undefined) return;
          if (identity.namespace.startsWith(DOCUMENT_NAMESPACE_PREFIX)) {
            changes.documents.add(documentKey(identity.namespace.slice(DOCUMENT_NAMESPACE_PREFIX.length), identity.key));
          } else if (identity.namespace === COLLECTION_NAMESPACE) changes.collections.add(identity.key);
          else if (!DERIVED.has(identity.namespace)) changes.other.add(identity.namespace);
        };
        let after: EventCursor = side.store.cursorAt(branchPoint);
        for (;;) {
          const batch = [...(yield* Stream.runCollect(side.store.events.read({ after, limit: EVENTS_BATCH })).pipe(
            Effect.catchTag("CursorCompacted", () =>
              Effect.fail(input.refuse(`"${side.store.partition}" has compacted its log past the branch point ${branchPoint}, so what it changed since cannot be read`))),
          ))];
          for (const event of batch) {
            if (event._tag === "ObjectPut") {
              if (event.identity !== undefined) identities.set(event.seq, event.identity);
              note(event.identity);
            } else note(identities.get(event.seq) ?? (yield* sharedIdentity(event.seq)));
          }
          if (changes.documents.size > MAX_CHANGES) return yield* input.refuse(`more than ${MAX_CHANGES} documents changed since the branch point; merge in smaller steps`);
          if (batch.length < EVENTS_BATCH) return changes;
          after = batch[batch.length - 1]!.cursor;
        }
      });

    const branchChanges = yield* changesOf(branch);
    const sourceChanges = yield* changesOf(source);
    const keep = (collection: string, id?: string) =>
      input.resolve.find((entry) => entry.collection === collection && entry.id === id)?.keep;

    const conflicts: MergeConflict[] = [];
    let conflictCount = 0;
    const conflict = (entry: MergeConflict) => { conflictCount += 1; if (conflicts.length < MAX_REPORTED) conflicts.push(entry); };

    // Definitions first: a document is merged under the collection it lands in.
    const branchCollections = new Map((yield* branch.documents.listCollections).map((entry) => [entry.name, entry]));
    const sourceCollections = new Map((yield* source.documents.listCollections).map((entry) => [entry.name, entry]));
    const create: Collection[] = [];
    for (const name of branchChanges.collections) {
      const ours = branchCollections.get(name), theirs = sourceCollections.get(name);
      if (definitionOf(ours) === definitionOf(theirs)) continue;
      if (ours !== undefined && theirs === undefined && !sourceChanges.collections.has(name)) { create.push(ours); continue; }
      if (keep(name) === "source") continue;
      conflict({ kind: "collection", collection: name });
    }

    const writes: DocumentWrite[] = [];
    let deletes = 0;
    for (const key of branchChanges.documents) {
      const [collection, id] = key.split("\u0000") as [string, string];
      const read = (side: Side) => side.documents.findById({ collection, id }).pipe(Effect.orElseSucceed(() => undefined));
      const ours = yield* read(branch), theirs = yield* read(source);
      const same = ours === undefined ? theirs === undefined : theirs !== undefined && canonical(ours.data) === canonical(theirs.data);
      if (same) continue;
      if (sourceChanges.documents.has(key)) {
        const settled = keep(collection, id);
        if (settled === "source") continue;
        if (settled !== "branch") {
          conflict({ kind: "document", collection, id, ...(theirs === undefined ? {} : { source: theirs.version }), ...(ours === undefined ? {} : { branch: ours.version }) });
          continue;
        }
      }
      if (ours === undefined) {
        deletes += 1;
        writes.push({ _tag: "Delete", collection, id, expectedVersion: theirs!.version });
      } else {
        writes.push(theirs === undefined
          ? { _tag: "Insert", collection, id, data: ours.data }
          : { _tag: "Upsert", collection, id, data: ours.data, expectedVersion: theirs.version });
      }
    }

    const settled = conflictCount === 0;
    if (settled && !input.dryRun) {
      for (const collection of create) {
        const { createdAt: _createdAt, derived: _derived, indexes, ...definition } = collection as Collection & { readonly derived?: unknown };
        yield* source.documents.createCollection({
          ...definition,
          ...(indexes === undefined ? {} : { indexes: indexes.map(({ state: _state, ...index }) => index) }),
        });
      }
      for (let at = 0; at < writes.length; at += WRITE_BATCH) {
        yield* source.documents.write({ operations: writes.slice(at, at + WRITE_BATCH) });
      }
    }
    return {
      ...(input.part === undefined ? {} : { part: input.part }),
      branchPoint,
      writes: writes.length - deletes,
      deletes,
      created: create.map((entry) => entry.name),
      conflicts,
      conflictCount,
      unmerged: [...branchChanges.other].sort(),
      settled,
    };
  });
