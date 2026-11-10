# A data-layout migration carries each Tenant's change history
Job: Make the data-layout migration (`packages/zelavis/src/adapters/_node-data-migration.ts`, run by `src/adapters/_node-project-runtime.ts`) carry each Tenant's change history, not just its final state. Proof: `distribution/scripts/format-migration/harness.mjs` against real alpha.42, with its time-series comparison extended so the points must match.
Date: 2026-11-10
Status: done
Verified-at: 57449988a6

To start:    Execute part 1 in /Users/ivanjeremicx/Projects/zelavis/.claude/worktrees/hopeful-goldstine-668fac/.agents/plans/2026-11-10-data-migration-carries-history/01-db-history-replay.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in /Users/ivanjeremicx/Projects/zelavis/.claude/worktrees/hopeful-goldstine-668fac/.agents/plans/2026-11-10-data-migration-carries-history/00-overview.md. Start with the first part that is not `done` (status table below), at its section 8.

## Status

| Part | File | Status |
|---|---|---|
| 1 | `01-db-history-replay.md` | done |
| 2 | `02-export-and-migration-history.md` | done |

Parts run in order, each in a fresh session. Part 2 depends on part 1.

## 0. Summary and finish line

alpha.43 moved the database from layout 2 to layout 4. A Project crosses that change through the explicit "stop, migrate
and switch" upgrade, which today recreates only each Tenant's final state: every document keeps its data, version, times
and expiry, but the change feed restarts with one event per document and time series rebuild from the final state only.
This plan replays each Tenant's whole document history, in order and at its original times, through the documents layer
of the current engine, then holds the final state to today's constraints, so the change feed and every time series rebuilt
from it are what they were before the migration.

**In scope (whole job)**
- Store: a transaction may stamp its events with a given time (`Txn.stampedAt`), used only by the migration.
- Documents layer: an internal, symbol-keyed history replay on `documents.write` (`REPLAY_HISTORY`), with a `Settle`
  request that checks a final state against the collection's constraints; a carried creation time for `createCollection`
  (`CARRY_COLLECTION`); schema activation (`declareFromSchema`) rewriting documents only when a lens declaration changed,
  so activating the recreated schemas after the replay adds no events.
- Export worker: a streamed NDJSON export with per-Tenant history kind (`log` or `state`), checked against the earlier
  engine's own reads, so a truncated export is refused instead of silently migrated.
- Migration: streamed, bounded three-pass recreation that replays `log` Tenants and recreates `state` Tenants as today.
- Report: `eventsCarried` and `tenantsWithoutHistory` on the migration report, its public type, the dashboard line and copy.
- Harness: a richer real-alpha.42 history (late unique index, late check, cascades, set-null, a dropped collection), exact
  change-feed comparison and exact time-series point comparison, both counted as differences.
- Docs: `website/.../architecture/updates.md`, `AGENTS.md` (Database rules), a changeset.

**Out of scope**
- Mapping old cursors: alpha.42 positions were shard-wide, so a cursor issued before the migration stays refused
  (`ForeignCursor`); its consumer reads again from the start and now receives the whole history.
- Collection lifecycle events in place: the new log starts with one `collection.created` per live collection, stamped at the
  Tenant history's first time; `collection.updated` events of the old log (index, check, reference changes) are not
  reproduced, because collections are created in their final definition.
- History of collections that no longer exist at the export, and of earlier collections of the same name: counted
  (`eventsOfDroppedCollections`), not carried.
- Schema history (saved versions are recreated, as today, after the documents), idempotency receipts and projection
  checkpoints (dropped, as today).
- Tenants whose earlier log was compacted: their export is state only, so they are recreated as today (counted as
  `tenantsWithoutHistory`).
- An active schema that implies a lens the earlier engine never declared (alpha.42 derived no declarations from schemas):
  recreating it applies that lens, which rewrites the collection's documents once, one event each at the migration's
  time. Stated in the docs; activation that changes no lens adds no event (part 1, step 7).
- The state path's latent ordering limit (a document inserted in an earlier batch than the document it references fails the
  strict insert): recorded as `[!]` A1 in part 2, outside this job.

**Done means**
- On real alpha.42 data, `node distribution/scripts/format-migration/harness.mjs --old-host <alpha.42 host>` prints
  `RESULT: identical answers on old and restored data` and exits 0, where the answers now include, per Tenant, the
  document change feed (type, collection, id, revision, timestamp, data, in order) and every `post-views` point
  (timestamp, value, tags, fields), compared exactly; at `--scale 1` and `--scale 10`, with timings recorded.
- `pnpm run verify` passes from the repository root after each part; `pnpm run ci:ui` and `pnpm run docs:check` after part 2.
- New tests cover replay, stamping, settle, the worker's truncation refusal, intermediate constraint states, cascades,
  dropped collections and the state path, failure paths included (sections 5 of both parts).
- The docs, `AGENTS.md`, the dashboard copy and the changeset say what is carried and what is not, in the same change.

**Reading of the job.** "Carry the change history" is read as: every document event (put and deletion) of a live
collection's history is recreated as an event of the new log, in the same order, with the same time, data, document
version and store revision, so a change-feed consumer reading from the start, and a time series rebuilt from the feed,
see what they saw before. Collection-definition events and schema history are not part of that reading (see Out of scope).

**Supplement** (`.agents/references/plan-writer.md`): updated. Freshness check from `53c038e024` found changed sources
(`AGENTS.md`, `.agents/skills/zelavis-release-maintainer/SKILL.md`, `.agents/references/two-fabrics-placement-contract.md`,
both package manifests at alpha.44); re-read, no fact changed, every cited path and symbol still resolves. `verified-at`
set to `57449988a6`. Three planning lessons added to Traps (worktree base and `node_modules`, finding release commits
without tags, the alpha.42 export's shard-wide cap). No execution reports since `lessons-through` (`.agents/plans/` was
empty), no finished plans to delete. Conflict flagged: `AGENTS.md § Repo Structure` still tells agents to update
`pnotes/TODO.md`, but the owner retired it on 2026-11-08 (open work lives in `.agents/plans/`); suggested wording for
`AGENTS.md`: "Open work and follow-ups live in `.agents/plans/` (plan-writer plans); `pnotes/TODO.md` may only shrink."

**Sources read**: `AGENTS.md` (Database Architecture Rules, Platform And App Service Boundary, Effect Version, TigerStyle,
Verification, Code Change Expectations), `.agents/references/plan-writer.md`, `.agents/references/tigerstyle-typescript.md`
(scope only), `website/src/content/docs/architecture/updates.md` § Data layout changes, the alpha.42 sources at release
commit `a01a6a322b` (`src/db/backup.ts`, `documents.ts`, `kv-store.ts`, `domain-events.ts`, `tenancy.ts`, `database.ts`),
`pnotes/fix_updates.md` § 14 (owner decision of 2026-11-01 that a first migration could reset history; this job reverses it
at the owner's request).

## Shared design (both parts rely on this)

1. **One-to-one replay.** Each document event of the old Tenant log (a put of a `doc/<tenant>/<collection>` record, or a
   retraction of one) becomes exactly one event of the new Tenant log: a put writes the old body's data, version and
   times; a retraction retracts. Cascade effects, set-null clears and index backfill rewrites were written by alpha.42 as
   events of their own (verified: `releaseReferences` and `rewriteDocuments` in alpha.42's `documents.ts` put and retract
   through the store), so replaying them one-to-one reproduces them, and the replay itself never cascades.
2. **No refusals during the replay; today's rules on the final state.** Every replayed event is a write alpha.42 already
   judged under the rules of its time. Replaying against the final constraints would refuse intermediate states (two
   users sharing an email before a unique index existed). So the replay derives every lens with the current engine from
   the collection's final definition but refuses nothing except unstorable data; then a `Settle` request runs today's
   constraint check (`enforceConstraints`) on each live document, inside a transaction, before the migration succeeds.
3. **Original times.** Each replayed event is stamped with the old event's `at` (`Txn.stampedAt`), so `DomainEvent.timestamp`
   and every time-series point keep their time. Collections are created first, in their final definition, stamped with the
   time of the Tenant history's first event, so the Tenant's log stays in time order wherever the earlier log was.
4. **Through the documents layer, never raw keys.** Replay and settle are internal options of `documents.write`, keyed by
   symbols like the shipped `CARRY_DOCUMENTS`, so nothing arriving as JSON can carry them; every manifest is derived by
   the current engine's `manifestFor`; the log is appended before the lenses are projected, as every write does.
5. **The export is checked against the engine that wrote it.** alpha.42's `exportTenant` reads at most 1,000,000 entries of
   the whole shard log and silently stops; the worker therefore compares each Tenant's export with that engine's own
   `listCollections` and `findPage` reads and refuses on any difference.
6. **Bounded.** Fewer than 1,000,000 events per Tenant (the worker's refusal), lines of at most 64 MiB, replay batches of
   500 changes per transaction, settle requests of 500 ids, one index entry per distinct old record in memory, the export
   read three times as a stream.

## Parts

1. `01-db-history-replay.md` — store stamping, `CARRY_COLLECTION`, `REPLAY_HISTORY` (`Changes`, `Settle`), activation
   rewriting only on a lens change, with tests.
   Lands green on its own: the options are internal and covered by their own tests. Depends on nothing.
2. `02-export-and-migration-history.md` — export format and worker, migration rewrite, report and its surfaces, dashboard
   copy, harness, docs. Builds on part 1's **NEW** `Txn.stampedAt`, `CARRY_COLLECTION`, `CarriedCollection`,
   `REPLAY_HISTORY`, `ReplayedChange`, `ReplayRequest` in `packages/zelavis/src/db/{store,document-writes}.ts`.
