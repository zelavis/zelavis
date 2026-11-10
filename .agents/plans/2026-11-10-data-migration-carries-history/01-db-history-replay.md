# The documents layer can replay an earlier engine's history
Job: Make the data-layout migration carry each Tenant's change history, not just its final state (part 1: the database primitives it needs).
Date: 2026-11-10
Status: planned
Verified-at: 57449988a6
Part: 1 of 2. Read 00-overview.md first.

To start:    Execute part 1 in /Users/ivanjeremicx/Projects/zelavis/.claude/worktrees/hopeful-goldstine-668fac/.agents/plans/2026-11-10-data-migration-carries-history/01-db-history-replay.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in /Users/ivanjeremicx/Projects/zelavis/.claude/worktrees/hopeful-goldstine-668fac/.agents/plans/2026-11-10-data-migration-carries-history/01-db-history-replay.md. Start with its section 8.

## Progress
- [ ] 1. Install, build and prove the existing migration tests pass at the starting commit
- [ ] 2. Let a store transaction stamp its events with a given time (`Txn.stampedAt`)
- [ ] 3. Split `documentPut` into its check and its write (`putDocument`), behavior unchanged
- [ ] 4. Carry a collection's creation time and event time (`CARRY_COLLECTION`)
- [ ] 5. Replay history changes through `documents.write` (`REPLAY_HISTORY` `Changes`)
- [ ] 6. Check a replayed final state against today's constraints (`REPLAY_HISTORY` `Settle`)
- [ ] 7. Rewrite documents on schema activation only when a lens declaration changed
- [ ] 8. Full verification from the repository root
- [ ] 9. Self-audit

## 0. Summary and finish line

The migration (part 2) must write an earlier engine's document history into the new database one event per old event,
at the old event's time, without the refusals and cascades a normal write performs, and then hold the final state to
today's constraints. This part adds exactly those primitives to `zelavis/db`, as internal options that only this
package's own code can pass, and tests them on their own. Nothing calls them yet; part 2 does.

**In scope**
- `Txn.stampedAt(at)` in `src/db/store.ts`, implemented in `src/db/kv-store.ts`.
- `putDocument` split out of `documentPut` in `src/db/document-writes.ts` (refactor, no behavior change).
- `CARRY_COLLECTION` on `createCollection`.
- `REPLAY_HISTORY` on `write`, with `Changes` and `Settle` requests.
- `declareFromSchema` (schema activation's backfill) rewrites the collection's documents only when the merge changed a
  declaration postings derive from. Today it rewrites every document unconditionally, one new event each, stamped now; the
  migration activates schemas after the replay, so those rewrites would add events the earlier history never had (and
  time-series points with them).
- `packages/zelavis/test/db-history-replay.test.mjs` (**NEW**).

**Out of scope**: the export worker, the migration, the report, the dashboard, the harness, the docs (part 2).

**Done means**
- The four primitives exist with the exact contracts of section 3, and activating a schema whose derived declarations
  change no lens writes no document event.
- `node --test test/db-history-replay.test.mjs` (from `packages/zelavis`, after a build) passes every case of section 5,
  and `node --test test/data-migration.test.mjs` still passes unchanged.
- `pnpm run verify` passes from the repository root.

**Supplement**: see `00-overview.md` § 0 (updated in this planning run).

**Sources read**: see `00-overview.md` § 0.

## 1. Context packet

### Glossary
- **Tenant log**: in layout 4 a shard holds many partitions, each with its own keys, identifiers, log and writer; a Tenant is
  normally one partition (`AGENTS.md § Database Architecture Rules`). Its log is a sequence of `ObjectPut`/`ObjectRetracted`
  events (`src/db/events.ts:16-58`), each with `at` (epoch ms, "when the write was accepted").
- **Domain event**: the change feed's reading of the log (`src/db/domain-events.ts:110-139`): a document put is
  `document.upserted` with `revision` = the store event's version and `timestamp` = `new Date(event.at)`.
- **Store version / revision**: the per-record counter the store increments on every put and retract
  (`src/db/kv-store.ts:891-896`), distinct from the **document version** field inside the document JSON.
- **History replay**: writing an earlier engine's document events again, one new event per old one, in order.
- **Settle**: checking a replayed final state against the collection's constraints, writing nothing.
- **Carry**: an internal, symbol-keyed write option that recreates something as it was elsewhere (`CARRY_DOCUMENTS`, shipped).

### Governing rules
- "Writes go through the documents API. There is no raw SQL surface and one must not be reintroduced"
  (`AGENTS.md § Database Architecture Rules`). Replay and settle are options of `documents.write`, like `CARRY_DOCUMENTS`.
- "Append to the log before projecting into the lenses. A crash must leave an event whose projection can be replayed, never
  a lens row with no event behind it." (same section). `txn.put` already appends then projects; do not change that order.
- "A document write checks what it depends on — the id, the version, a precondition, a unique value, a check, a reference —
  inside the transaction that writes it (`transactChecked` in `document-core.ts`), never before it" (same section). Replay
  deliberately refuses nothing but unstorable data (the overview's shared design, point 2); `Settle` is where today's
  checks run, and it runs inside a transaction.
- "A change that writes more than once in one transaction … threads one `Pending` overlay and reads every document, id and
  unique value through it" (same section). Replay threads one `Pending` per batch.
- "Effect v4 is mandatory for asynchronous orchestration … explicit failure channels" (`AGENTS.md § Effect Version`).
  Misuse of an internal option is a defect (`Effect.die(new RangeError(…))`), as `CARRY_DOCUMENTS` does; a data problem is a
  typed failure from the existing union.
- "No backward compatibility … Remove stale shapes and legacy paths outright" (`AGENTS.md § Code Change Expectations`).

### System today
- `src/db/store.ts:76-93` — the `Txn` interface (`put`, `retract`, `allocate`); `src/db/store.ts:444-446` — `transact`.
- `src/db/kv-store.ts:899-929` — `txnFor(into)`, the only `Txn` implementation; it stamps `at: Date.now()` at `:905` (put)
  and `:919` (retract). `:3083` — `transact: (f) => commit((into) => f(txnFor(into)))`.
- `src/db/document-core.ts:109-117` — `transactChecked`; `:200-206` — `collectionPut`; `:216-232` — `linkTargets`;
  `:290-301` — `currentNamed`; `:304-322` — `remember` / `forget`.
- `src/db/document-writes.ts:150-171` — `CARRY_DOCUMENTS` (the pattern to mirror); `:187-288` — `enforceConstraints`
  (checks, references, unique indexes, vector shape; returns the resolved edges); `:299-325` — `documentPut`;
  `:327-336` — `documentRetract`; `:349-421` — `releaseReferences` (cascades; replay must never call it); `:424` —
  `MAX_BATCH = 1000`; `:427-460` — `applyInsert`; `:587-635` — `rewriteDocuments`, whose link loop (`:608-622`) is the
  "re-derived, not re-checked" rule replay follows; `:638-735` — `createCollection` (`createdAt` at `:702`, transaction at
  `:725-733`); `:1212-1294` — `write`.
- `src/db/document-model.ts:1201-1216` — `write`'s public signature and error union (`CollectionNotFound | DocumentConflict |
  DocumentNotFound | SchemaViolation | TenantMoving | IdempotencyKeyReused | CheckViolation | UniqueViolation |
  ReferenceViolation | VectorShapeMismatch | InvalidDocumentValue | MessageExists | InvalidMessage`). Every failure this part
  adds is already in it.
- `test/data-migration.test.mjs:154-176` — the `CARRY_DOCUMENTS` test (pattern for symbol-option tests).
- `test/db-compaction.test.mjs:21-30` — `withStore`, opening one raw partition store (pattern for the stamping test).
- `test/_database.mjs:20-28` — `openTemporaryDatabase(t)`.

How a document write flows today: `write` validates the batch, settles ids, then `commitOnce` → `store.transact` runs one
transaction; each operation goes through `applyInsert`/`applyUpdate`/`applyDelete`, which read through the `Pending`
overlay, check, and call `documentPut` (`enforceConstraints` then `txn.put` with `manifestFor(...)`) or
`releaseReferences` + `documentRetract`. `txn.put` appends the event stamped `Date.now()` and projects its postings.

### Pattern to mirror
`src/db/document-writes.ts:150-171` and `:1217-1227`:

```ts
export const CARRY_DOCUMENTS: unique symbol = Symbol("zelavis.db.carryDocuments");
export interface CarriedDocument {
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface CarryDocumentsInput {
  readonly [CARRY_DOCUMENTS]?: ReadonlyArray<CarriedDocument | undefined>;
}
// in write:
        const carry = (input as CarryDocumentsInput)[CARRY_DOCUMENTS];
        ...
        if (carry !== undefined && (!Array.isArray(carry) || carry.length !== operations.length
          || carry.some((entry) => entry !== undefined && !isCarriedDocument(entry)))) {
          return yield* Effect.die(new RangeError("Carried documents name one version and two times per operation."));
        }
```

The link loop to mirror, `src/db/document-writes.ts:605-622` (inside `rewriteDocuments`):

```ts
              // Re-derived, not re-checked: these documents were accepted
              // once already, so a target that has since gone leaves the link
              // unposted rather than failing a rewrite.
              const links: Array<readonly [string, Seq]> = [];
              for (const definition of definitions) {
                const value = readPath(doc.data, definition.path);
                if (value === undefined || value === null) continue;
                const type = edgeTypeFor(collection, definition.name);
                for (const id of Array.isArray(value) ? value : [value]) {
                  if (typeof id !== "string") continue;
                  if (definition.collection === collection && id === doc.id) {
                    links.push([type, seq]);
                    continue;
                  }
                  const at = yield* lookup(documentNs(definition.collection), id);
                  if (at !== undefined) links.push([type, at]);
                }
              }
```

### Traps
- Reusing `applyInsert`/`applyUpdate` for replay → they stamp `new Date()` times and bump the version; replay writes the
  carried version and times exactly. Build the `Document` yourself and call `putDocument`.
- Calling `applyDelete` for a replayed retraction → it runs `releaseReferences`, which cascades and clears again what the
  history already holds as its own events. Call `documentRetract` only.
- Calling `enforceConstraints` during `Changes` → it refuses intermediate states the earlier engine accepted. Use
  `replayLinks` for edges; constraints run only in `Settle`.
- Reading the collection before the transaction → read it inside (`requireCollection` inside the `transactChecked` callback),
  as every write does.
- Widening the public `DocumentsApi.write` input type with the symbol keys → keep the cast pattern
  (`(input as ReplayHistoryInput)[REPLAY_HISTORY]`), as `CARRY_DOCUMENTS` does, so the public type stays JSON-shaped.
- Adding error classes → every data failure here already exists in `write`'s union; misuse dies.
- Changing `rewriteDocuments` to share the new helper → leave it as it is; it reads committed state with `lookup` and is out
  of scope. Duplicate the short loop in `replayLinks`, reading through the `Pending` overlay.
- Letting `stampedAt` accept any number → it accepts only safe integers ≥ 0; anything else dies at the first put or retract.
- `pnpm run build` while tests run from `dist/` → the build cleans `dist/`; run builds and tests one after the other
  (supplement Traps).

## 2. Design

**Authority and scope.** All state touched here belongs to one Tenant partition and is written under that partition's one
writer (`store.transact`). The new options carry no authority: they are reachable only from code holding a JS symbol
exported by `document-writes.ts`, which no transport (HTTP, CLI, SDK JSON) can construct. Their only caller will be the
data-layout migration (part 2), running in the Platform host against a private staging database.

**Persistence.** No new records. `stampedAt` changes only the `at` field of the stored events a transaction appends.
`CARRY_COLLECTION` changes the collection record's `createdAt` and its events' `at`. Replay writes ordinary document
records and events. Settle writes nothing (a transaction whose batch is empty is not written, `src/db/kv-store.ts:884-885`).

**Invariants**
1. An event's `at` is the time its write was accepted, except in a transaction the migration stamped; enforced by
   `stampedAt` being the only way to set it and by the symbol-keyed callers.
2. A stamp is a safe integer ≥ 0; enforced in `txnFor`'s `put` and `retract` (die otherwise, before appending).
3. A replayed put never moves a live document's version backwards (equal is allowed: index backfills rewrote documents
   unchanged); enforced in `replayChanges` with `DocumentConflict`.
4. A replayed retraction names a live document; enforced with `DocumentNotFound`.
5. A replayed batch is atomic: any failure discards every change of the batch (`transactChecked`).
6. Lenses of a replayed document are derived by this engine's `manifestFor` from the collection's current definition.
7. A replay request carries nothing else: no operations, messages, idempotency key, `WRITE_ALONG` or `CARRY_DOCUMENTS`;
   enforced by a die.

**Failure model**
- Misuse (malformed request, mixed with other inputs, 0 or more than 1000 changes or ids, bad stamp, bad carry) →
  `Effect.die(new RangeError(…))`.
- `CollectionNotFound` — a change or settle names a collection the Tenant does not have.
- `DocumentNotFound` — a retraction or settle names no live document.
- `DocumentConflict` — a put moves a live document's version back.
- `InvalidDocumentValue` — a put's data is not storable (`validateDocumentData`).
- `Settle` only: `CheckViolation`, `UniqueViolation`, `ReferenceViolation`, `VectorShapeMismatch` from `enforceConstraints`.
- `TenantMoving` — the partition is fenced (from `transactChecked`).
No interface other than the migration sees these; part 2 maps each `_tag` into its `DataMigrationFailure` message.

**Concurrency, bounds, interruption.** One transaction per request, under the store's one writer; at most `MAX_BATCH`
(1000) changes or ids per request. Settle holds the writer while it reads, which is what keeps its answers true. An
interrupted request leaves nothing (one batch or none). No unbounded loops: each loop runs over the request's own array.

**Deleted.** Nothing. `documentPut` keeps its signature; its body moves into `putDocument`.

**Decisions and rejected alternatives**
- *A per-event stamp on the transaction (`txn.stampedAt(at)` returning a `Txn`)* — chosen: a replay batch holds 500 events
  with 500 different times, and wrapping the `Txn` lets the existing helpers (`collectionPut`, `linkTargets`, `putDocument`,
  `documentRetract`) stamp without new parameters. Rejected: a per-transaction stamp (cannot carry 500 times); an Effect
  `Clock` override (hidden, and would also move `updatedAt` stamps and any timer under it).
- *Replay as an option of `write`, not a new `DocumentsApi` method* — chosen: the established internal pattern
  (`CARRY_DOCUMENTS`, `WRITE_ALONG`), invisible to every transport. Rejected: a public method (the parity rule would then
  require HTTP and CLI forms of an operation nobody but the migration may perform).
- *Settle as a second request kind of the same option* — chosen: it needs the same internals (`enforceConstraints`,
  `currentNamed`) and returns through the same union. Rejected: re-checking constraints in the migration with public reads
  (checks and unique indexes cannot be evaluated from outside without reimplementing them).
- *Edges re-derived, not re-checked* — chosen, as `rewriteDocuments` already does for documents "accepted once already".
- *Version equal allowed* — alpha.42 index backfills put each document again with its bytes unchanged
  (`rewriteDocuments` in alpha.42's `documents.ts`), so the history holds puts at the same document version.
- *Activation skips a rewrite that changes no posting* — chosen: the rewrite exists to re-derive postings under new
  declarations ("documents already stored must be re-derived under them", `schema-activation.ts:3-5`); when the merge
  changes no lens declaration the postings are already right, and the rewrite only adds events (and, through them,
  time-series points). This holds for every activation, not just the migration's. Rejected: a migration-only option to
  suppress it (a second path for the same rule); activating schemas before the replay (their events would be stamped
  now, ahead of the replayed history, breaking the log's time order).

**Decisions taken for the user**
- Collections are created in their final definition, stamped with the Tenant history's first time, rather than at their
  historical positions (so `collection.updated` events are not reproduced). Reason: creating them at their historical
  positions would need the intermediate definitions, whose index additions in the current engine rewrite documents and add
  events the old log never had. Recorded in the overview's Out of scope.

**Needs from the user**: none.

## 3. Contracts

### `src/db/store.ts` — `Txn` (add one member)

```ts
export interface Txn {
  readonly put: (seq: Seq, bytes: Uint8Array, manifest: IndexManifest, identity?: ObjectIdentity) => Effect.Effect<void, DbError>;
  readonly retract: (seq: Seq) => Effect.Effect<void, DbError>;
  readonly allocate: Effect.Effect<Seq, DbError>;
  /**
   * This transaction, with the events its puts and retractions append stamped `at` (epoch milliseconds, a safe integer
   * of at least 0) instead of the time they are written. For the data-layout migration only: it replays an earlier
   * engine's history, whose events happened when that engine accepted them. An event's time is otherwise always when
   * its write was accepted, so nothing else passes one.
   */
  readonly stampedAt: (at: number) => Txn;
}
```

### `src/db/document-writes.ts` — new exports

```ts
/**
 * A collection recreated as it was in another database, for this package's own use: the data-layout migration creates
 * each collection with the creation time the earlier engine recorded, and stamps the creation's events `at` (the time of
 * the first event of the history it replays next), so the Tenant's log reads in time order. Keyed by a symbol, so nothing
 * that arrives as JSON can carry it.
 */
export const CARRY_COLLECTION: unique symbol = Symbol("zelavis.db.carryCollection");
export interface CarriedCollection {
  /** ISO 8601, as the earlier engine stored it. */
  readonly createdAt: string;
  /** Epoch milliseconds, a safe integer of at least 0. */
  readonly at: number;
}
export interface CarryCollectionInput {
  readonly [CARRY_COLLECTION]?: CarriedCollection;
}

/**
 * An earlier engine's document history, replayed for this package's own use by the data-layout migration: each change is
 * one event of that history, written as one event here, at its own time, with the version and times it carried. A replay
 * refuses nothing the earlier engine accepted — every change was judged by it under the rules of its time, and its
 * cascades are changes of their own — except data this engine cannot store; `Settle` then holds the final state to
 * today's constraints. Keyed by a symbol, so nothing that arrives as JSON can carry it.
 */
export const REPLAY_HISTORY: unique symbol = Symbol("zelavis.db.replayHistory");
export type ReplayedChange =
  | {
      readonly _tag: "Put";
      readonly collection: string;
      readonly id: string;
      readonly data: JsonObject;
      /** The document version the earlier engine wrote; never below the live document's. */
      readonly version: number;
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly expiresAt?: string;
      /** When the earlier engine accepted it, in epoch milliseconds. */
      readonly at: number;
    }
  | {
      readonly _tag: "Retract";
      readonly collection: string;
      readonly id: string;
      readonly at: number;
    };
export type ReplayRequest =
  /** 1 to 1000 changes, in history order, in one transaction. */
  | { readonly _tag: "Changes"; readonly changes: ReadonlyArray<ReplayedChange> }
  /** 1 to 1000 live documents of one collection, checked against its constraints; writes nothing. */
  | { readonly _tag: "Settle"; readonly collection: string; readonly ids: ReadonlyArray<string> };
export interface ReplayHistoryInput {
  readonly [REPLAY_HISTORY]?: ReplayRequest;
}
```

Call shapes (part 2 uses exactly these):

```ts
yield* documents.createCollection({ ...definition, [CARRY_COLLECTION]: { createdAt, at } } as never);
yield* documents.write({ operations: [], [REPLAY_HISTORY]: { _tag: "Changes", changes } } as never);
yield* documents.write({ operations: [], [REPLAY_HISTORY]: { _tag: "Settle", collection, ids } } as never);
```

Both `write` forms succeed with `[]` (an empty `ReadonlyArray<DocumentWritten>`). Failures: section 2's failure model.
No HTTP route, SDK method or CLI command: these are internal options, unreachable from any transport by construction.

## 4. Execution steps

### Step 1. Install, build and prove the existing migration tests pass at the starting commit
- **Goal**: a working tree that builds, with the existing migration tests green before any change.
- **Files**: none changed.
- **Context**: a fresh worktree has no `node_modules` (supplement Traps). Tests import `../dist/...`, so build first.
  macOS sandboxes may point `/tmp` at a symlink that breaks host-operation tests; use a real `TMPDIR`.
- **Change**: none.
- **Depends on**: nothing.
- **Check** (repository root, zsh):
  `pnpm install --frozen-lockfile; echo "exit $?"` → `exit 0`.
  `pnpm --filter zelavis run build; echo "exit $?"` → `exit 0`, no `error TS` line.
  `cd packages/zelavis && TMPDIR=/private/tmp node --test test/data-migration.test.mjs; echo "exit $?"` → `# fail 0` and `exit 0`.

### Step 2. Let a store transaction stamp its events with a given time
- **Goal**: `Txn.stampedAt(at)` returns the same transaction with its appended events stamped `at`.
- **Files**: `packages/zelavis/src/db/store.ts`, `packages/zelavis/src/db/kv-store.ts`,
  `packages/zelavis/test/db-history-replay.test.mjs` (**NEW**).
- **Context**: `src/db/kv-store.ts:899-929` today:

  ```ts
  const txnFor = (into: Commit): Txn => ({
    put: (seq, bytes, manifest, identity) =>
      Effect.gen(function* () {
        const current = yield* readRecord(into.view, seq);
        const version = yield* nextVersion(current);
        yield* into.append({
          kind: "put", generation, seq, version, at: Date.now(), origin,
          ...(identity === undefined ? {} : { identity }), manifest, body: bytes,
        });
        ...
    retract: (seq) =>
      Effect.gen(function* () {
        const current = yield* readRecord(into.view, seq);
        if (current === undefined || !current.live) return;
        const version = yield* nextVersion(current);
        const position = yield* into.append({
          kind: "retract", generation, seq, version, at: Date.now(), origin,
          ...
    allocate: Effect.gen(function* () { ... }),
  });
  ```
- **Change**:
  - `store.ts`: add `stampedAt` to `Txn` exactly as section 3.
  - `kv-store.ts`: change the signature to `const txnFor = (into: Commit, stamp?: number): Txn => ({`; add at the start
    of both `put` and `retract` generators:
    `if (stamp !== undefined && !(Number.isSafeInteger(stamp) && stamp >= 0)) return yield* Effect.die(new RangeError(\`An event's time is epoch milliseconds, not ${stamp}.\`));`
    (in `retract`, place it before the `current === undefined` early return so a bad stamp never passes silently);
    replace both `at: Date.now()` with `at: stamp ?? Date.now()`; add the member
    `stampedAt: (at) => txnFor(into, at),`. `transact` at `:3083` stays `f(txnFor(into))`.
  - Imports: none new (`Effect` is already imported in both files).
  - Test file **NEW** `test/db-history-replay.test.mjs` with imports:
    ```js
    import assert from "node:assert/strict";
    import { mkdtempSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import test from "node:test";
    import { Cause, Effect, Exit, Stream } from "effect";
    import { asSeq } from "../dist/db/index.js";
    import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";
    import { openTemporaryDatabase } from "./_database.mjs";
    ```
    and the `withStore` helper copied from `test/db-compaction.test.mjs:21-30` (directory prefix `zv-stamp-`). Write case
    S1 and S2 of section 5.
- **Depends on**: 1.
- **Check** (repository root): `pnpm --filter zelavis run build; echo "exit $?"` → `exit 0`; then
  `cd packages/zelavis && node --test test/db-history-replay.test.mjs; echo "exit $?"` → `# fail 0`, `exit 0`.
  Write S2 first and see it fail before the change (it calls `txn.stampedAt`, which is not a function yet).

### Step 3. Split `documentPut` into its check and its write
- **Goal**: `putDocument` writes a document with given edges; `documentPut` = `enforceConstraints` + `putDocument`.
- **Files**: `packages/zelavis/src/db/document-writes.ts`.
- **Context**: `:299-325` today:

  ```ts
  const documentPut = (txn: Txn, doc: Document, seq: Seq, pending: Pending, loaded?: StoredCollection) =>
    Effect.gen(function* () {
      const collection = loaded ?? (yield* loadCollection(doc.collection));
      const edges = yield* enforceConstraints(collection, doc, seq, pending);
      const cells = yield* spatialHandle(collection?.spatial);
      yield* txn.put(seq, encode(doc), manifestFor(
        doc, collection?.indexes ?? [], collection?.analyzer, collection?.spatial, cells, edges,
        collection?.measures ?? [], collection?.columns,
      ), { namespace: documentNs(doc.collection), key: doc.id });
      remember(pending, collection, doc, seq);
      const proj = projectionIndexes.get(doc.collection);
      if (proj !== undefined && collection?.embedding !== undefined) { ... proj.add(...) }
    });
  ```
- **Change**: move everything from `const cells = …` to the end into
  `const putDocument = (txn: Txn, doc: Document, seq: Seq, pending: Pending, collection: StoredCollection | undefined, edges: ReadonlyArray<readonly [string, Seq]>) => Effect.gen(function* () { … });`
  with a doc comment: "Write a document with the postings its collection's definition derives and the given links, and
  remember it in the overlay. Checks nothing: `documentPut` checks first, and a history replay checks the final state with
  `Settle`." `documentPut` becomes `collection` + `edges` + `yield* putDocument(txn, doc, seq, pending, collection, edges)`.
  No caller changes. No imports.
- **Depends on**: 2.
- **Check**: build; `cd packages/zelavis && node --test test/data-migration.test.mjs test/db-history-replay.test.mjs; echo "exit $?"`
  → `# fail 0`, `exit 0`. (Full suite runs in step 7.)

### Step 4. Carry a collection's creation time and event time
- **Goal**: `createCollection` accepts `[CARRY_COLLECTION]` and then records its `createdAt` and stamps its events `at`.
- **Files**: `packages/zelavis/src/db/document-writes.ts`, `packages/zelavis/test/db-history-replay.test.mjs`.
- **Context**: `createCollection` (`:638-735`) sets `createdAt: new Date().toISOString(),` at `:702` and writes at `:725-733`:

  ```ts
        yield* transactChecked((txn) =>
          Effect.gen(function* () {
            const own = references
              .filter((reference) => reference.collection === input.name)
              .map((reference) => ({ collection: input.name, reference: reference.name }));
            yield* collectionPut(txn, seq, own.length === 0 ? declared : { ...declared, referencedBy: own });
            yield* linkTargets(txn, input.name, references.filter((reference) => reference.collection !== input.name));
          }));
  ```
  `linkTargets` (`src/db/document-core.ts:216-232`) puts the target collections' records in the same transaction; those
  events must carry the stamp too, or the log would step back in time.
- **Change**:
  - Add the section 3 `CARRY_COLLECTION`, `CarriedCollection`, `CarryCollectionInput` exports beside `CARRY_DOCUMENTS`, and
    `const isCarriedCollection = (value: CarriedCollection): boolean => typeof value === "object" && value !== null && typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt)) && Number.isSafeInteger(value.at) && value.at >= 0;`
  - At the top of `createCollection`'s generator, before `assertNotMoving`:
    `const carried = (input as CarryCollectionInput)[CARRY_COLLECTION];`
    `if (carried !== undefined && !isCarriedCollection(carried)) return yield* Effect.die(new RangeError("A carried collection names its creation time and an event time."));`
  - `:702` → `createdAt: carried?.createdAt ?? new Date().toISOString(),`
  - In the transaction: `const stamped = carried === undefined ? txn : txn.stampedAt(carried.at);` and pass `stamped` to
    both `collectionPut` and `linkTargets`.
  - Tests: cases C1, C2 of section 5.
- **Depends on**: 2.
- **Check**: build; `cd packages/zelavis && node --test test/db-history-replay.test.mjs; echo "exit $?"` → `# fail 0`, `exit 0`.

### Step 5. Replay history changes through `documents.write`
- **Goal**: `write({ operations: [], [REPLAY_HISTORY]: { _tag: "Changes", changes } })` writes each change as one event.
- **Files**: `packages/zelavis/src/db/document-writes.ts`, `packages/zelavis/test/db-history-replay.test.mjs`.
- **Context**: `write` (`:1212-1294`) begins:

  ```ts
    write: (input) =>
      Effect.gen(function* () {
        const operations = input.operations;
        const emit = input.emit ?? [];
        const along = (input as WriteAlongInput)[WRITE_ALONG];
        const carry = (input as CarryDocumentsInput)[CARRY_DOCUMENTS];
        if (!Array.isArray(operations) || !Array.isArray(emit)
          || (operations.length + emit.length === 0 && along === undefined) || operations.length > MAX_BATCH) {
          return yield* Effect.die(...);
        }
  ```
  An empty `operations` would die there, so the replay branch goes first. `requireCollection`, `currentNamed`,
  `transactChecked`, `validateDocumentData`, `readPath`, `edgeTypeFor`, `documentRetract`, `nothingPending` are all already
  in scope or imported (`:1-37`, `:174-179`).
- **Change**:
  - Add the section 3 `REPLAY_HISTORY`, `ReplayedChange`, `ReplayRequest`, `ReplayHistoryInput` exports after
    `CARRY_COLLECTION`.
  - Add module-level validators (plain TypeScript, after `isCarriedDocument`):
    ```ts
    const isStamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    const isTime = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));
    const isReplayedChange = (value: ReplayedChange): boolean =>
      typeof value === "object" && value !== null && typeof value.collection === "string" && typeof value.id === "string" && isStamp(value.at)
      && (value._tag === "Retract"
        || (value._tag === "Put" && typeof value.data === "object" && value.data !== null && !Array.isArray(value.data)
          && Number.isSafeInteger(value.version) && value.version >= 1 && isTime(value.createdAt) && isTime(value.updatedAt)
          && (value.expiresAt === undefined || typeof value.expiresAt === "string")));
    const isReplayRequest = (value: ReplayRequest): boolean =>
      typeof value === "object" && value !== null
      && ((value._tag === "Changes" && Array.isArray(value.changes) && value.changes.length >= 1 && value.changes.length <= 1000
          && value.changes.every(isReplayedChange))
        || (value._tag === "Settle" && typeof value.collection === "string" && Array.isArray(value.ids)
          && value.ids.length >= 1 && value.ids.length <= 1000 && value.ids.every((id) => typeof id === "string")));
    ```
    (1000 is `MAX_BATCH`; `MAX_BATCH` is declared inside `documentWrites`, so write the literal with a comment
    "`MAX_BATCH`", or move `const MAX_BATCH = 1000;` from `:424` to module level and use it in both places — do the move.)
  - Inside `documentWrites`, after `putDocument`, add `replayLinks` exactly as the overview-sanctioned loop:
    ```ts
    /**
     * A replayed document's links, re-derived and not re-checked, as `rewriteDocuments` does: every change of the history
     * was accepted once already, so a target not there at that moment of it leaves its link unposted. Read through the
     * batch's overlay, so a target written earlier in the batch counts and one retracted earlier does not.
     */
    const replayLinks = (collection: StoredCollection, doc: Document, seq: Seq, pending: Pending) =>
      Effect.gen(function* () {
        const links: Array<readonly [string, Seq]> = [];
        for (const definition of collection.edges ?? []) {
          const value = readPath(doc.data, definition.path);
          if (value === undefined || value === null) continue;
          const type = edgeTypeFor(doc.collection, definition.name);
          for (const id of Array.isArray(value) ? value : [value]) {
            if (typeof id !== "string") continue;
            if (definition.collection === doc.collection && id === doc.id) {
              links.push([type, seq]);
              continue;
            }
            const named = yield* currentNamed(pending, definition.collection, id);
            if (named !== undefined && named.document !== null) links.push([type, named.seq]);
          }
        }
        return links;
      });
    ```
  - Add `replayChanges`:
    ```ts
    /** One replayed batch: each change one event, at its own time, in one transaction; see `REPLAY_HISTORY`. */
    const replayChanges = (changes: ReadonlyArray<ReplayedChange>) =>
      Effect.gen(function* () {
        for (const change of changes) {
          if (change._tag === "Put") yield* validateDocumentData(change.collection, change.data);
        }
        return yield* transactChecked((txn) =>
          Effect.gen(function* () {
            const pending = nothingPending();
            for (const change of changes) {
              const collection = yield* requireCollection(change.collection);
              const at = yield* currentNamed(pending, change.collection, change.id);
              const stamped = txn.stampedAt(change.at);
              if (change._tag === "Retract") {
                if (at === undefined || at.document === null) {
                  return yield* new DocumentNotFound({ collection: change.collection, id: change.id });
                }
                yield* documentRetract(stamped, at.document, at.seq, pending);
                continue;
              }
              const live = at !== undefined && at.document !== null ? at : undefined;
              if (live !== undefined && change.version < live.document!.version) {
                return yield* new DocumentConflict({
                  collection: change.collection, id: change.id,
                  reason: `a replayed change moves version ${live.document!.version} back to ${change.version}`,
                });
              }
              const seq = live?.seq ?? (yield* txn.allocate);
              const doc: Document = {
                id: change.id, collection: change.collection, data: change.data,
                createdAt: change.createdAt, updatedAt: change.updatedAt, version: change.version,
                ...(change.expiresAt === undefined ? {} : { expiresAt: change.expiresAt }),
              };
              yield* putDocument(stamped, doc, seq, pending, collection, yield* replayLinks(collection, doc, seq, pending));
            }
            return [] as ReadonlyArray<DocumentWritten>;
          }));
      });
    ```
    Adjust the non-null assertions to the surrounding style if the type narrows without them.
  - In `write`, as the first lines of the generator:
    ```ts
        const replay = (input as ReplayHistoryInput)[REPLAY_HISTORY];
        if (replay !== undefined) {
          if (!isReplayRequest(replay) || !Array.isArray(input.operations) || input.operations.length !== 0
            || (input.emit ?? []).length !== 0 || input.idempotencyKey !== undefined
            || (input as WriteAlongInput)[WRITE_ALONG] !== undefined || (input as CarryDocumentsInput)[CARRY_DOCUMENTS] !== undefined) {
            return yield* Effect.die(new RangeError("A history replay is one request of 1 to 1000 changes or ids, and nothing else."));
          }
          return replay._tag === "Changes" ? yield* replayChanges(replay.changes) : yield* settleReplayed(replay.collection, replay.ids);
        }
    ```
    `settleReplayed` arrives in step 6; until then write the `Settle` branch as
    `yield* Effect.die(new RangeError("Settle is not implemented."))` only if you must build between steps — replace it in
    step 6 and do not leave it.
  - Imports: none new (`DocumentNotFound`, `DocumentConflict`, `DocumentWritten`, `Document`, `JsonObject`, `Pending`,
    `StoredCollection`, `Seq`, `Txn` are imported at `:1-37`).
  - Tests: cases R1–R5 of section 5.
- **Depends on**: 3.
- **Check**: build; `cd packages/zelavis && node --test test/db-history-replay.test.mjs; echo "exit $?"` → `# fail 0`, `exit 0`.

### Step 6. Check a replayed final state against today's constraints
- **Goal**: `Settle` runs `enforceConstraints` on named live documents inside a transaction and writes nothing.
- **Files**: `packages/zelavis/src/db/document-writes.ts`, `packages/zelavis/test/db-history-replay.test.mjs`.
- **Context**: `enforceConstraints(collection, doc, seq, pending)` (`:187-288`) refuses a failed check
  (`CheckViolation`), a missing reference target (`ReferenceViolation`), a value a ready unique index has another document
  holding (`UniqueViolation`, read from the postings, which after a replay hold exactly the live documents' values), a wrong
  vector shape (`VectorShapeMismatch`), and resolves edges (a missing edge target is a `ReferenceViolation`: the final
  state is held to today's rule here too). It reads inside the transaction it is given, which is the rule.
- **Change**: add after `replayChanges`:
  ```ts
  /**
   * Hold replayed documents to their collection's constraints as they stand now: what a replay did not check, because the
   * history it wrote passed through states the earlier engine accepted under the rules of their time. Inside a
   * transaction, under the store's one writer, like every check; it writes nothing.
   */
  const settleReplayed = (name: string, ids: ReadonlyArray<string>) =>
    transactChecked(() =>
      Effect.gen(function* () {
        const pending = nothingPending();
        const collection = yield* requireCollection(name);
        for (const id of ids) {
          const at = yield* currentNamed(pending, name, id);
          if (at === undefined || at.document === null) return yield* new DocumentNotFound({ collection: name, id });
          yield* enforceConstraints(collection, at.document, at.seq, pending);
        }
        return [] as ReadonlyArray<DocumentWritten>;
      }));
  ```
  Replace any interim `Settle` die from step 5. Tests: cases T1–T3 of section 5.
- **Depends on**: 5.
- **Check**: build; `cd packages/zelavis && node --test test/db-history-replay.test.mjs test/data-migration.test.mjs; echo "exit $?"`
  → `# fail 0`, `exit 0`.

### Step 7. Rewrite documents on schema activation only when a lens declaration changed
- **Goal**: `declareFromSchema` skips `rewriteDocuments` when the merged collection derives the same lenses as before.
- **Files**: `packages/zelavis/src/db/document-writes.ts`, `packages/zelavis/test/db-history-replay.test.mjs`.
- **Context**: schema activation (`src/db/schema-activation.ts:1-21`, "Apply the declarations to the collection and
  backfill every document's postings (`documents.declareFromSchema`)") calls `declareFromSchema`
  (`src/db/document-writes.ts:1078-1121`):

  ```ts
        const recorded = yield* transactOrDie((txn) =>
          Effect.gen(function* () {
            const current = yield* loadCollection(input.collection);
            if (current === undefined) return undefined;
            const merged = mergeDerived(current, wanted);
            yield* collectionPut(txn, seq, merged.collection);
            return { before: current, ...merged };
          }));
        if (recorded === undefined) return yield* new CollectionNotFound({ name: input.collection });
        const documents = yield* rewriteDocuments(input.collection);
        ...
            yield* rewriteDocuments(input.collection);   // after withdrawing a refused embedding
  ```
  `mergeDerived` (`:67-140`) changes only `analyzer`, `spatial`, `embedding`, `edges`, `measures` and `derived`; only the
  first five feed `manifestFor`. A declaration already made by hand is skipped (`declaredByHand`), so activating a schema
  over a collection that already declares what it implies changes no posting, yet today every document is put again,
  one event each, stamped now. alpha.42 had no `declareFromSchema` (its activation rewrote nothing), so the migration,
  which activates schemas after replaying the history, must not add those events.
- **Change**: add beside `sameJson` (`:40`)
  `const lensDeclarations = (collection: StoredCollection) => ({ analyzer: collection.analyzer, spatial: collection.spatial, embedding: collection.embedding, measures: collection.measures ?? [], edges: collection.edges ?? [] });`
  and in `declareFromSchema`:
  `const lensesChanged = !sameJson(lensDeclarations(recorded.before), lensDeclarations(recorded.collection));`
  `const documents = lensesChanged ? yield* rewriteDocuments(input.collection) : 0;`
  and make the withdrawal's rewrite `if (lensesChanged) yield* rewriteDocuments(input.collection);`. The embedding shape
  check that follows stays as it is (it reads; it does not depend on the rewrite). Update the doc comment of
  `declareFromSchema` in `src/db/document-model.ts` (find it with `grep -n "readonly declareFromSchema" src/db/document-model.ts`)
  to say the documents are rewritten only when a derived declaration changes what they post. Tests: D1, D2 of section 5.
- **Depends on**: 6.
- **Check**: build; `cd packages/zelavis && TMPDIR=/private/tmp node --test test/db-history-replay.test.mjs $(grep -l "declareFromSchema\|schemas.activate\|schemas.save" test/*.test.mjs); echo "exit $?"`
  → `# fail 0`, `exit 0` (every existing test that activates schemas still passes).

### Step 8. Full verification from the repository root
- **Goal**: every gate passes with the part landed.
- **Files**: none.
- **Context**: `AGENTS.md § Verification`: "Verify from the repository root, never from a package." The supplement:
  "Run builds and full verification sequentially."
- **Change**: none, unless a gate fails: fix the cause inside this part's files.
- **Depends on**: 7.
- **Check** (repository root): `TMPDIR=/private/tmp pnpm run verify; echo "exit $?"` → `exit 0`.

### Step 9. Self-audit
- **Goal**: the diff is exactly this part, and every check passes after the last edit.
- **Files**: none.
- **Change**: per section 8's Self-audit list.
- **Depends on**: 8.
- **Check**: `git diff --stat` lists only `packages/zelavis/src/db/store.ts`, `packages/zelavis/src/db/kv-store.ts`,
  `packages/zelavis/src/db/document-writes.ts`, `packages/zelavis/src/db/document-model.ts` (one doc comment),
  `packages/zelavis/test/db-history-replay.test.mjs` and this plan folder;
  `TMPDIR=/private/tmp pnpm run verify; echo "exit $?"` → `exit 0`.

## 5. Tests

All in `packages/zelavis/test/db-history-replay.test.mjs` (**NEW**), `node:test` + `node:assert/strict`, run with
`cd packages/zelavis && node --test test/db-history-replay.test.mjs` after a build. Use `openTemporaryDatabase(t)` for
document-level cases; `const tenant = opened.database.forTenant("tenant-a")`; run Effects with `Effect.runPromise` /
`Effect.runPromiseExit`. Helpers inside the file:

```js
const feed = async (tenant) => (await Effect.runPromise(tenant.events.read({ limit: 1000 }))).events;
const failed = async (effect) => { const exit = await Effect.runPromiseExit(effect); assert.ok(Exit.isFailure(exit)); return exit; };
const tagOf = (exit) => Cause.squash(exit.cause)._tag;
const iso = (ms) => new Date(ms).toISOString();
const put = (collection, id, data, version, at, extra = {}) => ({ _tag: "Put", collection, id, data, version, createdAt: iso(at), updatedAt: iso(at), at, ...extra });
const retract = (collection, id, at) => ({ _tag: "Retract", collection, id, at });
const replay = (documents, changes) => documents.write({ operations: [], [REPLAY_HISTORY]: { _tag: "Changes", changes } });
const settle = (documents, collection, ids) => documents.write({ operations: [], [REPLAY_HISTORY]: { _tag: "Settle", collection, ids } });
```
(import `REPLAY_HISTORY`, `CARRY_COLLECTION` from `../dist/db/document-writes.js` at the top of the file once step 4/5
adds them.)

- **S1 — an event is stamped when its write was accepted.** Arrange: `withStore`. Act: `before = Date.now()`; in one
  `store.transact`, `seq = yield* txn.allocate; yield* txn.put(seq, enc("a"), emptyManifest, { namespace: "n", key: "k" })`.
  Assert: the one event from `Stream.runCollect(store.events.read())` has `at >= before` and `at <= Date.now()`.
  (`emptyManifest` = `{ terms: [], columns: [], measures: [], edges: [] }`.)
- **S2 — `stampedAt` stamps puts and retractions, and refuses a bad time.** Arrange: `withStore`. Act: transact
  `txn.stampedAt(1234).put(seq, …)`, then another transact `txn.stampedAt(5678).retract(seq)`. Assert: events' `at` are
  `[1234, 5678]` and `_tag`s `["ObjectPut", "ObjectRetracted"]`. Then for each of `-1`, `1.5`, `Number.NaN`,
  `Number.MAX_SAFE_INTEGER + 2`: a transact putting with `txn.stampedAt(bad)` exits with `Cause.hasDies(exit.cause)`, and
  the event count is still 2.
- **C1 — a carried collection keeps its creation time, and its events and its targets' carry the event time.** Arrange:
  `documents = tenant.documents`. Act: `createCollection({ name: "posts", [CARRY_COLLECTION]: { createdAt: "2026-01-02T03:04:05.000Z", at: 1000 } })`,
  then `createCollection({ name: "comments", references: [{ name: "post", path: "post", collection: "posts", onDelete: "cascade" }], [CARRY_COLLECTION]: { createdAt: "2026-01-03T00:00:00.000Z", at: 1000 } })`.
  Assert: `listCollections` gives `posts.createdAt === "2026-01-02T03:04:05.000Z"`; `feed(tenant)` holds
  `collection.created` for both and `collection.updated` for `posts` (its `referencedBy` link), every one with
  `timestamp === iso(1000)`.
- **C2 — a malformed carry refuses.** For each of `{ createdAt: "yesterday", at: 1 }`, `{ createdAt: iso(0), at: -1 }`,
  `{ at: 1 }`: `createCollection({ name: "x", [CARRY_COLLECTION]: carry })` dies; `listCollections` has no `x`.
- **R1 — history replays one event per change, at its time, with its version.** Arrange: `users` with
  `indexes: [{ name: "by_email", fields: [{ path: "email" }], unique: true }]`,
  `checks: [{ name: "adult", where: [{ path: "age", op: "gte", value: 18 }] }]`; `posts` with
  `edges: [{ name: "wrote", path: "author", collection: "users" }]`. Act: one `replay` of
  `put(users,u1,{email:"a",age:10},1,1000)`, `put(users,u2,{email:"a",age:30},1,1100)`,
  `put(users,u2,{email:"b",age:30},2,1200)`, `put(users,u1,{email:"a",age:30},2,1300)`,
  `put(users,u1,{email:"a",age:30},2,1350)` (a backfill rewrite: same version), `retract(users,u2,1400)`,
  `put(users,u2,{email:"c",age:40},1,1500)`, `put(posts,p1,{author:"u1"},1,1600)`.
  Assert: it succeeds with `[]` although u1 failed `adult` and u2 shared u1's email at their time; the document events of
  `feed(tenant)` are, as `[type, documentId, revision, timestamp, payload.data?.email]`:
  `[upserted,u1,1,iso(1000),a]`, `[upserted,u2,1,iso(1100),a]`, `[upserted,u2,2,iso(1200),b]`, `[upserted,u1,2,iso(1300),a]`,
  `[upserted,u1,3,iso(1350),a]`, `[deleted,u2,3,iso(1400),undefined]`, `[upserted,u2,1,iso(1500),c]`,
  `[upserted,p1,1,iso(1600),undefined]` (u2's re-creation is a new record, so its revision restarts);
  `findById(users,u1)` has `version 2`, `createdAt iso(1350)`, `updatedAt iso(1350)` (the last put's carried times: the
  `put` helper stamps both times with its `at`);
  `findMany({ collection: "users", where: [{ path: "email", op: "eq", value: "c" }] })` → `["u2"]` (the index holds only the
  live value); `findMany({ collection: "users", linked: { collection: "posts", id: "p1", edge: "wrote" } })` → `["u1"]`.
- **R2 — a replayed retraction does not cascade.** Arrange: `posts`; `comments` referencing `posts` with
  `onDelete: "cascade"`; replay `put(posts,p1,{},1,10)`, `put(comments,c1,{post:"p1"},1,20)`. Act: replay
  `retract(posts,p1,30)`. Assert: `count(comments) === 1`; the feed's last event is `document.deleted` for `p1` only.
- **R3 — a failure discards the whole batch.** Arrange: `users` empty. Act and assert, each as its own `replay`:
  `[put(users,u9,{},1,1), retract(users,missing,2)]` → `DocumentNotFound`, and `count(users) === 0`;
  `put(users,u1,{},3,1)` then `[put(users,u1,{},2,2)]` → `DocumentConflict`; `[put(nowhere,x,{},1,1)]` →
  `CollectionNotFound`; `[put(users,u2,{ age: Number.POSITIVE_INFINITY },1,1)]` → `InvalidDocumentValue`.
- **R4 — a malformed request dies and writes nothing.** Each dies (`Cause.hasDies`): `changes: []`; 1001 changes;
  a change with `version: 0`, with `at: -1`, with `createdAt: "yesterday"`, with `_tag: "Upsert"`; a replay with
  `operations: [{ _tag: "Insert", collection: "users", data: {} }]`; with `idempotencyKey: "k"`; with
  `emit: [{ topic: "t", payload: {} }]`. After all of them `count(users)` is unchanged.
- **R5 — replay events keep the log in time order with a carried collection first.** Arrange: `createCollection` of `notes`
  with `[CARRY_COLLECTION]: { createdAt: iso(500), at: 500 }`. Act: replay `put(notes,n1,{},1,500)`, `put(notes,n1,{},2,900)`.
  Assert: the feed's timestamps are non-decreasing and start with `iso(500)`.
- **T1 — a settled final state passes and writes nothing.** Arrange: R1's final state. Act: `settle(users, ["u1","u2"])`,
  `settle(posts, ["p1"])`. Assert: both `[]`; the feed length is unchanged.
- **T2 — settle refuses what today's rules refuse.** Arrange: `users` as in R1. Act and assert each:
  replay `put(users,a1,{email:"x",age:20},1,1)`, `put(users,a2,{email:"x",age:20},1,2)` then `settle(users,["a1","a2"])` →
  `UniqueViolation`; replay `put(users,k1,{email:"k",age:5},1,3)` then `settle(users,["k1"])` → `CheckViolation`; with
  `comments` referencing `posts`, replay `put(comments,c9,{post:"nope"},1,4)` then `settle(comments,["c9"])` →
  `ReferenceViolation`; `settle(users,["ghost"])` → `DocumentNotFound`; `settle(nowhere,["x"])` → `CollectionNotFound`.
- **T3 — a malformed settle dies.** `ids: []`, 1001 ids, `ids: [1]`, `collection: 5` each die.
- **D1 — activating a schema that changes no lens writes no document event.** Arrange: `notes` created with
  `analyzer: { fields: ["title"], version: 1, fold: true }`; insert `n1` `{ title: "alpha one" }`, `n2` `{ title: "alpha two" }`,
  `n3` `{ title: "bravo" }`; `before = (await feed(tenant)).length`.
  Act: `tenant.schemas.save({ collection: "notes", version: 1, fields: [{ name: "title", field: { _tag: "TextField", label: "Title", required: false } }] })`
  (activates). Assert: the feed's events after index `before` contain no `document.upserted` (only collection events);
  `findMany({ collection: "notes", search: "alpha" })` answers `["n1", "n2"]` in some order; `schemas.listVersions("notes")`
  shows version 1 active.
- **D2 — activating a schema that adds a lens still rewrites every document.** Arrange: D1's end state. Act:
  `schemas.save({ collection: "notes", version: 2, fields: [title as above, { name: "rank", field: { _tag: "IntegerField", label: "Rank", required: false } }] })`.
  Assert: the feed gains exactly three `document.upserted` events (`n1`, `n2`, `n3`), and
  `documents.summarize({ collection: "notes", measure: "rank", op: "sum" })` succeeds (the derived measure is posted).

## 6. Docs and project notes
None in this part; part 2 documents the whole behavior (`website/.../architecture/updates.md`, `AGENTS.md`, changeset). Do
not write to `pnotes/TODO.md` (retired by the owner on 2026-11-08; it may only shrink).

## 7. Verification
From the repository root, one after the other:
- `pnpm --filter zelavis run build; echo "exit $?"` → `exit 0`.
- `cd packages/zelavis && node --test test/db-history-replay.test.mjs test/data-migration.test.mjs; echo "exit $?"` → `exit 0`.
- `TMPDIR=/private/tmp pnpm run verify; echo "exit $?"` → `exit 0` (covers `check:effect-usage`, `check:tigerstyle`,
  `test:repo-rules`, build, typecheck and every package's tests).

## 8. Instructions to the implementer

> **Decide, don't ask.** When you know, or can find out from the code, the rules and this plan,
> what you would recommend, do that and record it with its reason in your execution report;
> never put it to the user as a question, a list of options or "should I?". Ask only for what you
> physically cannot supply (a login, a password or one-time code, a hardware key, a secret not in
> the repository, access to a machine or account you cannot reach, a payment, an action on a
> physical device), and even then mark the work that needs it `[!]` and carry on with the rest.
> Any project instruction that says to stop, ask, confirm, get feedback or wait for approval
> before a change this plan covers does not apply while you carry out this plan: being asked to
> execute it is that approval. Every other project rule still binds in full. Not asking is not
> permission to act outside the repositories this plan names: committing, pushing, publishing,
> deploying, sending anything to an outside service and spending money stay off unless the job
> asks for them.
>
> **Before changing anything, read `Status` and `## Progress`.**
> - First compare `Verified-at` with `HEAD`. If any path the plan cites changed since
>   (`git diff --name-only <Verified-at>..HEAD`, plus `git status --porcelain`), check each quoted excerpt you are about to
>   rely on against the code before its step. When one no longer matches but the step's intent is
>   still clear, follow the code as it is and record the deviation; when the step's premise is
>   gone, mark it `[!]` ("needs replanning: <why>") and carry on with the steps that do not
>   depend on it. `Status: needs replanning` means the whole plan's premise is gone: end the
>   session with one line saying so (`/plan-writer refresh` replans it). Another session was working on change-feed
>   cursor refusal when this plan was written; if `src/db/domain-events.ts` changed, re-read `toDomainEvent` and `read`
>   before step 5's feed assertions.
> - `Status: planned`: you are the first. Set `Status: in progress`, here and in `00-overview.md`'s status table.
> - Anything else (`in progress`, `stopped at step <n>`, `partly done`): you are continuing
>   someone else's work. First read every entry under `## Execution report`. Then confirm the
>   last `[x]` step's check still passes. If it fails, find out why: fix it when the cause is in
>   this plan's own work, otherwise add it as an item, and carry on. Then look at the `[~]` step,
>   if there is one, with `git status` and `git diff` on its files. Finish it if its change is
>   partly there, or redo it if it is wrong; never redo a step marked `[x]`. Check each `[!]`
>   line too: when what it waited for is now there (the user supplied it, or the job now names
>   the repository or the action), set it to `[ ]` and work it like any other line; a `[!]`
>   "needs replanning" stays for `/plan-writer refresh`. Then set `Status: in progress`.
> - `Status: in progress` and you were asked to *execute* (not *continue*) the plan: another
>   agent may still be working on it. Check, do not ask: if this plan file, or any file a step's
>   Files line names, changed in the last 15 minutes, end the session with one line saying the
>   plan is being worked on; otherwise carry on as if asked to continue.
>
> **Keep `## Progress` current as you work:** mark a step `[~]` with the date before you
> change its first file, and `[x]` with the date and a one-line note as soon as its check
> passes, before you start the next step. Never mark `[x]` a step whose check you did not see
> pass.
>
> **Nothing left over lives only in chat.** Whenever a step leaves anything not done, not
> proven, deferred, "later", "not built", "not done now", "not done yet", a known gap or a
> follow-up, however you would phrase it, add it to `## Progress` as an added item (`A<n>`,
> before the Self-audit line, with where it came from, why it was left and the check that will
> prove it) before you mark the step `[x]`. Never hide it in the step's one-line note. An item
> inside this plan's scope is `[ ]` and yours to finish: keep working through the checklist,
> however long it takes, until no `[ ]` line is left. An item that needs something only the user
> can physically supply, or lies outside the plan's scope, is `[!]`; record it and carry on with
> the rest.
>
> **Do not list leftovers to the user.** After a step, and in your final report, never write
> lists headed "Not done", "Not proven", "Later", "Not built" or the like. Say only how many
> items you added and which kind, in one line: "Added 3 items to the checklist (A4–A6), 1 needs
> you (A6)." The checklist is where they live; the user reads it there.
>
> Read section 1 first and return to it whenever you are unsure. Carry out section 4 step by step,
> in order, and run each step's check before starting the next. Tests you write are run in the
> same step, before you move on; never leave them for the end. Do not redesign, rename or
> "improve" anything the plan did not ask for. Match the surrounding code's style, naming and
> comment density.
>
> **When the plan and the code disagree, decide; never improvise and never stop to ask:**
> - a referenced file or symbol does not exist or differs from the plan: find where it went.
>   When the step's intent is still clear, follow the code and record the deviation; when its
>   premise is gone, mark the step `[!]` ("needs replanning: <why>") and carry on with the steps
>   that do not depend on it;
> - a check fails and the cause is not a simple mistake in your own change: investigate until
>   you know the cause, fix it when it is inside this plan's scope, otherwise add it as an item;
> - a gate would need a suppression, baseline entry, wrapper or shim to pass: never add one.
>   Make the honest change pass; when that needs work outside this plan, mark the step `[!]`
>   with the reason and carry on;
> - the plan contradicts the project's instruction files: those win. Follow them and record
>   where they conflict.
>
> **An unexpected result is a finding, never noise**: two checks that disagree, a diagnostic
> that never settles, a number far from what the plan expects (a revision in R1 that is not the one listed, a feed with
> an extra event). Investigate it in this session until you know its cause, even when every check passes. If the fix stays
> inside this plan's files and rules, make it and test it; otherwise add it as an item with its cause and the fix. Never
> report it as "unexplained" without having looked.
>
> Forbidden in this project: compatibility aliases or legacy fallbacks; silent catches, `Effect.ignore` or
> `Effect.ignoreCause`; unbounded Effect concurrency; unchecked `JSON.parse` casts; `async` functions or Promise
> orchestration in Platform code; new error classes for this part; widening the public `DocumentsApi` types with the
> symbol keys; anything written in the repository's `.claude/` folder; writes to
> `pnotes/TODO.md`; edits to generated output (`dist/`, `website/dist/`, `website/.astro/`) or `repos/effect/`. Never
> edit generated output. Do not commit, push or publish unless told to.
>
> **Self-audit before you report done** (the plan's last step). Check your own work once more:
> - re-read your whole diff (`git diff`, plus new files) against sections 1–5: every step's change
>   is there, nothing is there the plan did not ask for, and no other person's file was touched;
> - every item of Done means holds, checked, not assumed;
> - rerun every test the plan added or touched, and the project's full verification, and see
>   them pass now, after your last edit;
> - search your diff for the forbidden patterns listed above, leftover debug output, temporary
>   files and TODOs you added;
> - every unexpected result you met has a known cause;
> - no `[ ]` or `[~]` line is left above Self-audit, and every leftover you noticed anywhere (your
>   notes, your diff's comments, test output, this report) is an added item.
> Fix what the audit finds (only inside the plan's scope), rerun the checks, and record the audit
> and what it found in your report.
>
> When you finish or stop, add your own entry under `## Execution report` at the end of this
> file, below any earlier entries, which you never edit. Head it `### Session <n>: <date>`:
> - the final status, and the steps you carried out. Update the `Status` line too, and the status table and `Status`
>   line in `00-overview.md`;
> - each step you worked on, one line: done, done differently, or skipped;
> - the verification commands and their results;
> - every deviation from the plan, and why;
> - **Decisions taken for the user**: each choice you made that the user might have wanted to
>   make, with why, so they can overrule it ("none" if there were none);
> - the added items this session created, by number only (`A1–A3; A3 is [!]`), since their
>   text lives in `## Progress`;
> - **Context the plan lacked**: what you had to find out yourself, or got wrong at first, that
>   the plan should have told you. Write "none" if there was nothing.
>
> Then give the user the same report, shortened, with the added items and the decisions taken as
> counts only. It asks nothing.

## Execution report
