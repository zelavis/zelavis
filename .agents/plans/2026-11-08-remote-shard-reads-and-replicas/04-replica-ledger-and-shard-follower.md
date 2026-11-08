# Part 4 (B): replica roles in the ledger, the shared follow loop and a shard-scoped leader
Job: Remote App shards beyond bytes, part 4: the Platform's ledger learns replica entries, and the follower algorithm becomes callable by a shard replicator without a second copy of it.
Date: 2026-11-08
Status: done
Verified-at: 53c038e024 (plus the uncommitted working tree of 2026-11-08)
Part: 4 of 5. Read 00-overview.md first.

To start:    Execute part 4 in .agents/plans/2026-11-08-remote-shard-reads-and-replicas/04-replica-ledger-and-shard-follower.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-08-remote-shard-reads-and-replicas/04-replica-ledger-and-shard-follower.md. Start with its section 8.

## Progress
- [x] 1. 2026-11-08. Add `role`, `of` and `intent` to the ledger's records and requests. TypeScript build and 14 contract tests passed.
- [x] 2. 2026-11-08. Admit replica requests: anti-affinity, one per shard, envelope. TypeScript build passed.
- [x] 3. 2026-11-08. Refuse releasing a primary with a live replica; release replicas first on deletion. TypeScript build passed.
- [x] 4. 2026-11-08. Pass the caller's Node to admission; carry role and intent through the Project channel. TypeScript build and 15 Project channel and placement tests passed.
- [x] 5. 2026-11-08. Test the ledger, the model, activation order and the channel. 49 tests passed, including 200 model seeds, and both guard mutations failed as expected.
- [x] 6. 2026-11-08. Extract the follow loop into `followPartitions`. All 35 existing follower tests passed unchanged.
- [x] 7. 2026-11-08. Add the shard-scoped leader `shardLeader`. TypeScript build and TigerStyle passed.
- [x] 8. 2026-11-08. Test following one shard into a bare shard store. Five shard leader tests passed and allowing zv.global through failed the copy test.
- [x] A1. 2026-11-08. Preserve the lag guarantee under bounded catch-up. The extracted loop can leave work behind when a partition pass or feed page reports more, so it can incorrectly report a level turn. Prove a burst spanning the pass limit catches up without another write, and that a partial feed page cannot advance the level timestamp. Regression failed before the fix and all 41 follower tests passed after it.
- [x] 9. 2026-11-08. Self-audit passed. Root verification exited 0 and reran every touched test.

## 0. Summary and finish line

Two foundations for replicas, each useful and tested on its own: **(1)** the Platform's ledger holds replica entries
(`role: "replica"`, `of`), admits them by decision D8's rules and orders their release; **(2)** `followAll`'s loop is extracted,
unchanged, into `followPartitions(leader, side, options)` with an optional per-turn report, and `shardLeader` presents one shard
of a database as a `DatabaseLeader`, so part 5's replicator is `followPartitions(shardLeader(…), replicaSide, …)` and nothing
else. No App-side operation, surface or doc changes here.

**In scope:** `src/platform/app-data-placement.ts`, `app-shard-activation.ts`, `app-shard-routes.ts`; `src/db/shard-authority-http.ts`,
`src/db/shard-placement.ts` (types of the host request only); `src/db/leader.ts`; tests.
**Out of scope:** opening replicas, the operation, surfaces, docs (part 5). The Agent: no change (a replica is an ordinary shard
key to it, D8).

**Done means:**
- The ledger accepts `intent: "replica"` requests by D8's rules and refuses the rest with the stable reasons of section 3; B1
  and B2 tests pass and fail with their guards removed.
- The seeded ledger model (`test/app-shard-ledger-model.test.mjs`) includes replica operations and still holds its invariants
  over 200 seeds.
- `followAll` is `followPartitions` over the database's side; every existing follower test passes unchanged.
- `shardLeader` lets `followPartitions` copy exactly one shard's Tenant partitions into a bare store, drop the ones routed away,
  and never copy `zv.global` or another reserved partition (test).
- `pnpm run verify; echo "exit $?"` → `exit 0`.

**Supplement:** see `00-overview.md` section 0.

## 1. Context packet

**Glossary:** as in `00-overview.md` (replica, primary, shard epoch, ledger, replicator) plus *side*: what `followAll` writes into
(the follower's routed stores, its shards, how it removes a partition, its partition listing).

**Governing rules (quoted).**
- "Replicas never imply multiple writable owners" (`AGENTS.md § Project Vision`).
- "Never add a second follower algorithm for the remote case." (`AGENTS.md § Database Architecture Rules`, durability bullet) —
  equally for the replica case: extract, do not copy.
- "A full listing is the rare resync path and may be as long as the data." (`AGENTS.md § Database Architecture Rules`, rule one)
- Contract, Versioned exchange: requests carry an "intent (`allocate`, `move`, `replica`, or `release`)"; "The Platform … refuses an
  unknown intent, an out-of-envelope request, or release of a shard still referenced".

**System today.**
- Ledger: `AppShardPlacementRequest` (`app-data-placement.ts:25`), `AppShardPlacement` (`:64`), `AppShardPlacementRefusal` (`:83`),
  `validRequest` (`:153`: virtualRanges non-empty; all resources positive), `validPlacement` (`:173`: virtualRanges non-empty),
  `decodeLedger` (`:201`), `fingerprint` (`:221`), `request` (`:371–456`: `range-conflict` at `:400`, envelope at `:401–403`,
  eligible nodes `:404–409`, bounded-load choice `:413`), `beginRelease` (`:359`).
- Activation: `revokeAll` (`app-shard-activation.ts:155`) releases live entries one at a time in ledger order (sorted by shardId).
- Routes: `runtime.projectShards.request` (`app-shard-routes.ts:149–158`) calls `authority.request(checked.claims.scope, body)`;
  `checked.claims.node` is the caller's Node (the capability's node, checked equal to the active placement's `nodeId`, `:119`).
- Channel: `httpShardChannel.request` (`shard-authority-http.ts:107`) posts `{ protocolVersion: 1, projectId, ...rest, resources }`;
  `isEntry` (`:44`) parses list entries. `ShardPlacementHost.request` input type (`shard-placement.ts:67–74`).
- Allocation: `createAppShardAllocationStore.set` sums live entries' resources and checks their nodes (`app-shard-allocation.ts:89–104`);
  replicas are counted with no change.
- Follower loop: `followersOver` (`leader.ts:494`) builds `FollowersApi`; `followAll` (`:605–730`) uses `input.routed`,
  `input.shardFor`, `input.remove`, `input.writes`, `input.changed`, `input.partitionsPage` and `input.declarations.declare`, and
  `leader.feed|partitions|source|declarations|acknowledge`. Its loop: on no cursor or a full retry set, `feed({ timeoutMillis: 0 })`,
  `declare`, `prune`, `resync`; else `feed({ cursor, timeoutMillis })`, `levelAll(answer.partitions ∪ retry)`.
  `tipOf` (`:152`) is the head-event fingerprint used to tell equal-length logs apart.
- `DatabaseLeader` (`:376`), `LeaderFeed` (`:164`, `FeedWire` `:124`: `{ cursor, partitions, resync, more, declarations }`),
  `LeaderPartitions` (`:165`: `{ partitions: { partition, head, tip? }[], next? }`), `localDatabaseLeader` (`:389`).
- `PartitionStats` (`src/db/store.ts:203`): `incarnation` absent while nothing was written; `followAll`'s `level` removes a partition
  the leader holds nothing of (`:618–628`), except `GLOBAL_TENANT`.
- Reserved names: `isReservedTenantId` (`src/db/naming.ts:38`); `GLOBAL_TENANT = "zv.global"` (`src/db/topology.ts:31`); the change
  feed touches `zv.global` too (`touchFeed`, `database.ts`).

**Traps.**
- Copying `followAll`'s body into a new function → no: move it, and make `followAll` call it.
- Treating a missing `role` in a stored ledger as "primary" → no fallback (decision below): the field is required.
- Letting `zv.global` through the shard leader's filter → it hashes to some shard and would copy the App-scoped store.
- Validating `of` against the ledger only → a local primary has no ledger entry; anti-affinity then uses the caller's Node.

## 2. Design

- **Authority:** only the Platform writes the ledger (unchanged). The caller's Node comes from the verified capability, never from
  the request body.
- **Persistence:** the ledger record gains, per entry, `role` and (replica only) `of`; requests gain `intent` and `of`. The ledger's
  `protocolVersion` stays 1 and `role` is required: the remote-shard feature is uncommitted, so no ledger written by a release
  exists (no migration, no fallback; `AGENTS.md § Code Change Expectations`).
- **Invariants:** B1, B2 (overview table); and: a replica entry has `virtualRanges: []`, a primary entry has at least one; a replica's
  `shardId === of + ".replica"`; `of` never ends in `.replica`.
- **Failure model (refusals, all 409 except `invalid-request` 400):** `invalid-request` (shape, a replica of a replica, wrong replica
  id, ranges on a replica, a primary without ranges, disk 0); `replica-exists` (a live replica of `of`); `no-eligible-node` (no Node
  but the primary's); `out-of-envelope`; `replica-live` (beginRelease of a primary with a live replica); the existing ones otherwise.
- **Bounds:** unchanged ledger bounds (256 placements, 4096 operation ids); one replica per shard caps replicas at the number of
  shards.
- **Interruption:** every transition stays one conditional write (`mutate`).
- **Follow loop:** `followPartitions` is `followAll`'s body over a `FollowerSide`; it calls `turns(turn)` after each turn when given:
  `asked` = the clock time read just before that turn's feed request (for a resync turn, before `feed({ timeoutMillis: 0 })`), `level`
  = the retry set is empty after the turn, `resynced` = the turn was a resync. Use `Clock.currentTimeMillis` (testable).
- **Shard leader:** a `DatabaseLeader` for shard `S` of the writer's own database:
  - `feed`: cursor `"<fingerprint>\u0002<inner cursor>"` where `fingerprint` names S's placements in the current map (its
    `{from,to}` placements in order, joined); a different fingerprint (or none) answers `resync: true` with a fresh cursor; otherwise
    it calls the inner `followers.feed` repeatedly with the remaining time, keeping only partitions `p` with `p !== GLOBAL_TENANT &&
    !isReservedTenantId(p) && shardOf(p) === S`, until something is owed for S, the inner answer says `resync` or `more`, the
    fingerprint changed (then `resync`), or the time is up; `declarations` is always 0.
  - `partitions({ after, limit })`: a page of S's own store (`partitionsPage`), filtered as above, each with `head` and `tip`
    (`tipOf`) read through `routed(p)`; `next` = the last raw partition when the raw page was full.
  - `source(p)`: `shardOf(p) === S` and passes the filter → `followers.source(p)`; otherwise an *absent source* whose `stats` answer
    `{ records: 0, bytes: 0, head: 0, compactedTo: 0, nextSeq: 0, seeding: false }` (no `incarnation`) and whose other members fail
    with `StoreError({ op: "shard-leader.absent", cause: "<p> is not on <S>" })` (never called: `level` removes first).
  - `declarations`: `{ placements: { version: 0, collections: {} }, subdivisions: { version: 0, tenants: {} } }`; no `acknowledge`
    (D6: no per-partition acknowledgments).
  A resync costs the partitions on S, and happens at the start and whenever S's placements change (a move on or off S): the rare path.
- **Decisions:**
  - Replica id `<of>.replica`. **Rejected:** a counter suffix (one replica per shard; the id must be derivable for cleanup).
  - Replica resources `{ cpuCores ≥ 0, memoryBytes ≥ 0, diskBytes > 0 }`. **Rejected:** requiring a CPU core for a disk copy.
  - Resync on S's fingerprint, not on any map version. **Rejected:** resyncing every replica on every move anywhere.
- **Decisions taken for the user:** at most one replica per shard (bounded, simplest proof; more copies are more entries of the same
  kind later).
- **Needs from the user:** none.

## 3. Contracts

```ts
// app-data-placement.ts
export type AppShardPlacementRole = "primary" | "replica";
export interface AppShardPlacementRequest {
  readonly protocolVersion: 1;
  readonly intent: "allocate" | "replica";
  readonly operationId: string;
  readonly projectId: string;
  readonly shardId: string;            // for a replica: `${of}.replica`
  readonly of?: string;                // replica only
  readonly virtualRanges: readonly number[];   // replica: []
  readonly mapVersion: number;
  readonly expectedRevision: number;
  readonly resources: { readonly cpuCores: number; readonly memoryBytes: number; readonly diskBytes: number };
  readonly durability: "crash" | "power";
}
export interface AppShardPlacement { /* existing fields */ readonly role: AppShardPlacementRole; readonly of?: string; }
export type AppShardPlacementRefusal = /* existing */ | "replica-exists" | "replica-live";
// AppShardPlacementAuthority.request gains the caller's Node:
readonly request: (callerProjectId: string, input: unknown, caller: { readonly nodeId: string }) => Promise<AppShardPlacementDecision>;
```
`fingerprint` includes `intent` and `of`. Admission for `intent: "replica"`: `of` valid and not ending `.replica`; `shardId === of +
".replica"`; `virtualRanges.length === 0`; `diskBytes ≥ 1`, `cpuCores ≥ 0`, `memoryBytes ≥ 0` (integers); no live entry with
`role: "replica"` and the same `of` (`replica-exists`); excluded Node = the live primary entry of `of` if there is one, else
`caller.nodeId`; eligible Nodes filtered by `node.id !== excluded`; skip the range-conflict check; envelope as for any entry.
`intent: "allocate"` keeps today's rules and records `role: "primary"`.

```ts
// shard-placement.ts: ShardPlacementHost.request input gains
readonly intent: "allocate" | "replica";
readonly of?: string;
// ShardPlacementView placements gain
readonly role: "primary" | "replica";
readonly of?: string;
```
The existing `place` passes `intent: "allocate"`.

```ts
// leader.ts
export interface FollowerSide {
  readonly routed: (partition: PartitionKey) => ObjectStoreApi;
  readonly partitionsPage: (after: string | undefined, limit: number) =>
    Effect.Effect<{ readonly partitions: ReadonlyArray<PartitionKey>; readonly next?: string }, DbError>;
  readonly shardFor: (partition: PartitionKey) => ShardStoreApi;
  readonly changed: (partition: PartitionKey) => Effect.Effect<void>;
  readonly remove: (partition: PartitionKey) => Effect.Effect<void, DbError | PlacementInUse>;
  readonly writes: SubscriptionRef.SubscriptionRef<number>;
  readonly declare: (wanted: LeaderDeclarations) => Effect.Effect<void>;
}
export interface FollowTurn { readonly asked: number; readonly level: boolean; readonly resynced: boolean }
export const followPartitions: (leader: DatabaseLeader, side: FollowerSide, options: {
  readonly name?: string; readonly concurrency?: number; readonly timeoutMillis?: number;
  readonly turns?: (turn: FollowTurn) => Effect.Effect<void>;
}) => Effect.Effect<never, DbError | InvalidFollowerRequest>;
export const shardLeader: (input: {
  readonly shard: ShardId;
  readonly followers: FollowersApi;                         // the writer database's own
  readonly shardOf: (partition: PartitionKey) => ShardId;   // routing now
  readonly placementsOf: () => string;                      // S's placement fingerprint in the current map
  readonly store: () => ShardStoreApi | undefined;          // S's open store, undefined while it is not open
  readonly routed: (partition: PartitionKey) => ObjectStoreApi;
}) => DatabaseLeader;
```
`store()` undefined → `partitions` fails `StoreError({ op: "shard-leader.partitions", cause: "shard <S> is not open" })`;
`followPartitions`' `reachable` retries it with its capped backoff.

## 4. Execution steps

### Step 1. Add `role`, `of` and `intent` to the ledger
1. **Goal:** records and requests carry the new fields, validated.
2. **Files:** `src/platform/app-data-placement.ts`.
3. **Context:** `validRequest` (`:153`), `validPlacement` (`:173`), `fingerprint` (`:221`), the `request` placement literal (`:419`).
4. **Change:** section 3 types; `validRequest` allows the `intent` and `of` keys and checks them by intent; `validPlacement` checks
   `role` and the ranges/of rule; `request` writes `role: "primary"` for `allocate`.
5. **Depends on:** none.
6. **Check:** build → no `error TS`; `cd packages/zelavis && node --test test/app-data-placement-contract.test.mjs; echo "exit $?"` →
   fails only where tests send requests without `intent`: add `intent: "allocate"` to those request fixtures (they are this file's).

### Step 2. Admit replica requests
1. **Goal:** D8's admission rules.
2. **Files:** `src/platform/app-data-placement.ts`.
3. **Context:** section 3 admission paragraph; `request` (`:371–456`).
4. **Change:** branch on `intent` after the shared checks (operation id, revision, `shard-in-use`, `ledger-full`): for a replica, the
   `replica-exists` check, the excluded Node, no range check; the envelope sum and bounded-load choice unchanged (loads count every
   live entry on a Node). Record `role: "replica"`, `of`.
5. **Depends on:** 1, 4 (the `caller` parameter; do step 4's signature change first if the compiler requires it).
6. **Check:** build → no `error TS`.

### Step 3. Refuse releasing a primary with a live replica; release replicas first on deletion
1. **Goal:** B2.
2. **Files:** `src/platform/app-data-placement.ts` (`beginRelease`, `:359`), `src/platform/app-shard-activation.ts` (`revokeAll`, `:155`).
3. **Change:** `beginRelease` of a `role: "primary"` entry while a live `role: "replica"` entry names it in `of` → `replica-live`
   (the replica's own release is unaffected). `revokeAll`: sort `live` so replicas come first, keep `concurrency: 1`.
4. **Depends on:** 1.
5. **Check:** build → no `error TS`.

### Step 4. Pass the caller's Node to admission; carry role and intent through the channel
1. **Goal:** the Platform knows the caller's Node; the App can ask for and see replicas.
2. **Files:** `src/platform/app-shard-routes.ts` (`:154`), `src/db/shard-authority-http.ts` (`request`, `isEntry`, `list`),
   `src/db/shard-placement.ts` (`ShardPlacementHost`, `ShardPlacementView`, the `requested` phase passes `intent: "allocate"`).
3. **Change:** `authority.request(checked.claims.scope, body, { nodeId: checked.claims.node })`; the channel sends `intent` and `of`;
   `isEntry` accepts `role` (required, `"primary" | "replica"`) and optional `of`; the list maps them through.
4. **Depends on:** 1.
5. **Check:** build → no `error TS`; `cd packages/zelavis && node --test test/db-shard-placement.test.mjs test/app-shard-project-routes.test.mjs; echo "exit $?"`
   → `exit 0` (update their fakes to include `role: "primary"` where they build ledger entries).

### Step 5. Test the ledger, the model, activation order and the channel
1. **Goal:** B1, B2 and the model with replicas.
2. **Files:** `test/app-data-placement-contract.test.mjs`, `test/app-shard-ledger-model.test.mjs`, `test/app-shard-activation.test.mjs`,
   `test/db-shard-placement.test.mjs` (channel cases at `:479`, `:511`).
3. **Change — tests:**
   - **"replica admission: anti-affinity, one per shard, no ranges, envelope"** (B1): a primary `shard-2` committed on node-b; a
     replica request for `of: "shard-2"` with nodes node-b and node-c → granted on node-c; a second replica request → `replica-exists`;
     with only node-b eligible → `no-eligible-node`; a replica of a local `shard-0` with caller node-a and nodes node-a, node-b →
     node-b; ranges on a replica, `shardId` not `<of>.replica`, `of: "x.replica"`, `diskBytes: 0` → `invalid-request`; a replica whose
     disk exceeds what is left of the allocation → `out-of-envelope`.
   - **"a primary with a live replica is not released; revokeAll releases replicas first"** (B2): `beginRelease(primary)` →
     `replica-live`; after the replica is released, the primary releases; `revokeAll` with a fake dispatcher records the order of
     `released` deliveries: the replica's comes first.
   - The ledger model: add replicate/unreplicate operations to its random sequence and the invariants "no live replica shares its
     primary's Node" and "at most one live replica per `of`"; keep 200 seeds.
   - Channel: a request with `intent: "replica"` posts it; a list entry without `role` is a malformed ledger.
4. **Depends on:** 2, 3, 4.
5. **Check:** after a build, `cd packages/zelavis && node --test test/app-data-placement-contract.test.mjs test/app-shard-ledger-model.test.mjs test/app-shard-activation.test.mjs test/db-shard-placement.test.mjs; echo "exit $?"` →
   `exit 0`; then remove the anti-affinity filter and the `replica-live` check one at a time, see B1 and B2 fail, restore; record it.

### Step 6. Extract the follow loop into `followPartitions`
1. **Goal:** one follower loop with two callers.
2. **Files:** `src/db/leader.ts`.
3. **Context:** `followAll` (`:605–730`) and the `input` fields it reads (section 1).
4. **Change:** move the body into exported `followPartitions(leader, side, options)` (section 3), replacing `input.x` with `side.x`
   and `input.declarations.declare` with `side.declare`; add the `turns` report (section 2). `followAll: (leader, options) =>
   followPartitions(leader, { routed: input.routed, partitionsPage: input.partitionsPage, shardFor: input.shardFor, changed:
   input.changed, remove: input.remove, writes: input.writes, declare: input.declarations.declare }, options)`.
5. **Depends on:** none.
6. **Check:** after a build, `cd packages/zelavis && node --test test/db-followers.test.mjs test/db-follow-database.test.mjs test/db-follow-whole-database.test.mjs test/db-remote-follower.test.mjs; echo "exit $?"` → `exit 0`.

### Step 7. Add the shard-scoped leader `shardLeader`
1. **Goal:** one shard of the writer's database as a `DatabaseLeader`.
2. **Files:** `src/db/leader.ts`.
3. **Context:** section 2 (shard leader), `tipOf` (`:152`), `followers.feed` input (`LeaderFeedInput`, `:422`).
4. **Change:** implement `shardLeader` (section 3) with the bounded inner-feed loop (each inner call gets the remaining time; at most
   one inner call per write in the database, and none while nothing is written).
5. **Depends on:** 6.
6. **Check:** build → no `error TS`; `pnpm check:tigerstyle; echo "exit $?"` → `exit 0`.

### Step 8. Test following one shard into a bare shard store
1. **Goal:** the shard leader and `followPartitions` copy exactly one shard.
2. **Files:** `test/db-shard-leader.test.mjs` (NEW).
3. **Context:** a `makeDatabase` over memory engines with `partitionMapFor(["s0", "s1"])` (as `test/db-tenant-reads.test.mjs`
   of part 2 or `test/db-shard-placement.test.mjs:135` builds one); the target is `openShardOverKv("s1.replica", memoryKvEngine())`.
   The database's internals the leader needs: build it in the test from public pieces — `db.followers`, `db.shardOf`,
   `db.topology.current()` (placements), and `db.shards`. If `db` does not expose S's `ShardStoreApi` or `routed`, add a database
   method `shardLeaderFor(shard): DatabaseLeader` to `DatabaseApi` (it wires `shardLeader` with the internals) and test that instead;
   part 5 uses it. Record which.
4. **Change — tests:**
   - **"following a shard copies its Tenants and nothing else"**: Tenants on both shards, one App-scoped replicated collection, a
     `service:x` partition on s1; fork `followPartitions(leader(s1), replicaSide(target), { timeoutMillis: 50, turns })` in a scope;
     `waitFor` a turn with `level && resynced`; assert the target's non-reserved partitions equal s1's Tenant partitions (plus
     `service:x`), each with the same `stats.head` and records; `zv.global` absent on the target.
   - **"a write on the shard reaches the copy, a write elsewhere does not"**: write on an s1 Tenant and on an s0 Tenant; `waitFor` the
     target's head of the s1 Tenant to move; the s0 Tenant never appears.
   - **"a Tenant moved off the shard is dropped from the copy; one moved on is copied"**: `db.movement.rebalance` an s1 range to s0
     and an s0 range to s1; `waitFor` the target to match s1 again.
   - **"turns report when the copy is level"**: `asked` of a level turn is ≤ the time the test read just after the last write.
   `replicaSide(target)` in the test: `routed = target.partition`, `shardFor = () => target`, `remove = (p) => Effect.asVoid(target.drop(p))`,
   `partitionsPage` over `target.partitionsPage` filtered non-reserved, `changed = () => Effect.void`, `writes = SubscriptionRef.make(0)`,
   `declare = () => Effect.void` (part 5 moves this into `src/db/shard-replicas.ts`).
5. **Depends on:** 7.
6. **Check:** after a build, `cd packages/zelavis && node --test test/db-shard-leader.test.mjs; echo "exit $?"` → `exit 0`; then make the
   filter let `zv.global` through, see the first test fail, restore; record it.

### Step 9. Self-audit
See section 8. Check: `cd /Users/ivanjeremicx/Projects/zelavis && pnpm run verify; echo "exit $?"` → `exit 0`.

## 5. Tests
Step 5 (ledger, model, activation, channel) and step 8 (`test/db-shard-leader.test.mjs`, NEW); every existing follower test runs in
step 6. Failure paths: each refusal of section 2, a shard that is not open (the leader's `partitions` fails and is retried).

## 6. Docs and project notes
None in this part (no user-visible change). The contract's decided section already describes D8.

## 7. Verification
`cd /Users/ivanjeremicx/Projects/zelavis && pnpm run verify; echo "exit $?"` → `exit 0`.

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
> - First compare `Verified-at` with `HEAD`. The cited remote-shard files are untracked, so also run `git status --porcelain`
>   and check each quoted excerpt you rely on against the file before its step. When one no longer matches but the step's intent
>   is still clear, follow the code as it is and record the deviation; when the step's premise is gone, mark it `[!]` ("needs
>   replanning: <why>") and carry on with the steps that do not depend on it. `Status: needs replanning` means the whole plan's
>   premise is gone: end the session with one line saying so (`/plan-writer refresh` replans it).
> - Check part 1 is `done` in `00-overview.md` and read the execution reports of every earlier part that is done (parts 2–3 may
>   have landed first; their changes to `database.ts`, `node-host.ts` and the drill are theirs to keep). Adapt this part to any
>   deviation there and record how.
> - `Status: planned`: you are the first. Set `Status: in progress`, and set this part's row in `00-overview.md` to `in progress`.
> - Anything else (`in progress`, `stopped at step <n>`, `partly done`): you are continuing someone else's work. First read every
>   entry under `## Execution report`. Then confirm the last `[x]` step's check still passes. If it fails, find out why: fix it
>   when the cause is in this plan's own work, otherwise add it as an item, and carry on. Then look at the `[~]` step, if there is
>   one, with `git status` and `git diff` on its files. Finish it if its change is partly there, or redo it if it is wrong; never
>   redo a step marked `[x]`. Check each `[!]` line too: when what it waited for is now there, set it to `[ ]` and work it like any
>   other line; a `[!]` "needs replanning" stays for `/plan-writer refresh`. Then set `Status: in progress`.
> - `Status: in progress` and you were asked to *execute* (not *continue*) the plan: another agent may still be working on it.
>   Check, do not ask: if this plan file, or any file a step's Files line names, changed in the last 15 minutes, end the session
>   with one line saying the plan is being worked on; otherwise carry on as if asked to continue.
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
> Read section 1 first and return to it whenever you are unsure. Carry out section 4 step by step, in order, and run each step's
> check before starting the next. Tests you write are run in the same step, before you move on. Do not redesign, rename or
> "improve" anything the plan did not ask for. Match the surrounding code's style, naming and comment density.
>
> **When the plan and the code disagree, decide; never improvise and never stop to ask:**
> - a referenced file or symbol does not exist or differs from the plan: find where it went. When the step's intent is still
>   clear, follow the code and record the deviation; when its premise is gone, mark the step `[!]` ("needs replanning: <why>")
>   and carry on with the steps that do not depend on it;
> - a check fails and the cause is not a simple mistake in your own change: investigate until you know the cause, fix it when it
>   is inside this plan's scope, otherwise add it as an item;
> - a gate would need a suppression, baseline entry, wrapper or shim to pass: never add one. Make the honest change pass; when that
>   needs work outside this plan, mark the step `[!]` with the reason and carry on;
> - the plan contradicts the project's instruction files: those win. Follow them and record where they conflict.
>
> **An unexpected result is a finding, never noise**: two checks that disagree, a diagnostic that never settles, a number far from
> what the plan expects. Investigate it in this session until you know its cause, even when every check passes. If the fix stays
> inside this plan's files and rules, make it and test it; otherwise add it as an item with its cause and the fix. Never report it
> as "unexplained" without having looked. An existing follower test that changes behaviour after step 6 is such a finding: the
> extraction must be behaviour-preserving.
>
> Forbidden in this project: compatibility aliases or legacy fallbacks; silent catches, `Effect.ignore` or `Effect.ignoreCause`;
> unbounded concurrency; unchecked `JSON.parse` casts; `async` functions, `new Promise` or Promise coordination in `src/`; growing
> `scripts/effect-migration-baseline.json`; fixed sleeps standing in for a condition in tests; docs that describe planned work as
> shipped; anything written in `.claude/`; any write to `pnotes/TODO.md`; edits to `dist/`, `website/dist/`, `website/.astro/` or
> `repos/effect/`. Never edit generated output. Do not commit, push or publish unless told to.
>
> **Self-audit before you report done** (the plan's last step). Check your own work once more:
> - re-read your whole diff (`git diff`, plus new and untracked files you changed) against sections 1–5: every step's change is
>   there, nothing is there the plan did not ask for, and no other person's file was touched;
> - every item of Done means holds, checked, not assumed;
> - rerun every test the plan added or touched, and the project's full verification, and see them pass now, after your last edit;
> - search your diff for the forbidden patterns listed above, leftover debug output, temporary files and TODOs you added;
> - every unexpected result you met has a known cause;
> - no `[ ]` or `[~]` line is left above Self-audit, and every leftover you noticed anywhere (your notes, your diff's comments,
>   test output, this report) is an added item.
> Fix what the audit finds (only inside the plan's scope), rerun the checks, and record the audit and what it found in your report.
>
> When you finish or stop, add your own entry under `## Execution report` at the end of this file, below any earlier entries,
> which you never edit. Head it `### Session <n>: <date>`:
> - the final status, and the steps you carried out. Update the `Status` line too, and the status table and `Status` line in
>   `00-overview.md`;
> - each step you worked on, one line: done, done differently, or skipped;
> - the verification commands and their results;
> - every deviation from the plan, and why;
> - **Decisions taken for the user**: each choice you made that the user might have wanted to make, with why ("none" if there were none);
> - the added items this session created, by number only (`A1–A3; A3 is [!]`);
> - **Context the plan lacked**: what you had to find out yourself, or got wrong at first, that the plan should have told you.
>   Write "none" if there was nothing.
>
> Then give the user the same report, shortened, with the added items and the decisions taken as counts only. It asks nothing.

## Execution report

### Session 1: 2026-11-08

Status: done. Steps 1–9 and A1 passed. The overview remains in progress with Part 5 planned.

1. Done. Added the required ledger role and request intent, validated the role-specific shard shapes, and included intent and `of` in the fingerprint.
2. Done. Admitted disk-only replicas through the existing allocation and CAS, excluding the primary's Node and refusing a second live replica. Pulled the authenticated caller parameter and route wiring forward from step 4 for this build.
3. Done. A live replica blocks a primary's release. Project deletion revokes replicas before primaries.
4. Done. The channel forwards `intent` and `of` in its existing request body and validates and maps the ledger role. Existing place operations send `allocate`.
5. Done. Tested replica admission, release ordering, the Project channel, and 200 seeded sequences with replica operations. Updated the existing remote Project authorization fixture to include valid allocate intent so it still isolates the client-supplied Node check.
6. Done. Moved the whole-database loop into `followPartitions` with an optional per-turn report. All 35 existing follower tests passed before the A1 follow-up.
7. Done. The shard leader reads the live store and routing, filters reserved partitions, and resyncs on changes to that shard's placements.
8. Done. Exercised the production `db.shardLeaderFor(shard)` wiring with a bare memory store. Covered seed contents and heads, on-shard writes, moves in both directions, turn timing, filtered pagination, and typed retry of an unopened shard.
9. Done. Reviewed the edited hunks and new files, confirmed the three temporary guard mutations were restored, and checked whitespace and forbidden patterns. Root verification reran all touched tests and exited 0.

**Verification.** `pnpm --filter zelavis exec tsc -p tsconfig.json` passed at each build step. The placement contract, ledger model, activation, shard placement and remote Project suites passed 49 tests. The Project route and placement suites passed 15 tests at step 4. The four existing follower suites passed 35 tests at extraction. The same suites plus `test/db-shard-leader.test.mjs` passed 41 after A1. `pnpm check:tigerstyle` and `git diff --check` passed. The targeted tests failed with the anti-affinity filter, primary-release guard, or global exclusion independently disabled. The backlog regression also failed before its fix. All restored tests passed under `pnpm run verify` (exit 0).

**Decisions taken for the user**

- Reserved the `.replica` suffix for replicas so a primary cannot claim the deterministic replica key. The live entry at that key gives `replica-exists` after the existing idempotent replay and revision checks.
- Preserved anti-affinity in reverse admission order as well. A later primary allocation excludes its existing replica's Node, and a primary already releasing refuses new replicas with `wrong-state`. Both checks are covered by the ledger CAS and tested.
- Added `DatabaseApi.shardLeaderFor` because `db.shards` exposes lifecycle controls and does not expose the store or router needed by the leader. Part 5 can use the same wiring.
- Kept bounded partition passes in the retry set and withheld the level report while a feed page or retry set still owed work. The retry set now caps membership at 10,000 and resyncs on overflow. Updated the Part 5 handoff to enter following on the first level turn, which can occur after the initial listing's turn.

**Added items.** A1.

**Context the plan lacked.** HEAD matched `Verified-at` and the prior implementation was already in the working tree. The overview records Parts 1–3 as done and their files removed. There were no earlier execution reports left in the split plan, so the existing contract and source provided the handover. The shard channel already spreads the request input into the wire payload. The seeded model needed to preserve idempotent release of an already released primary even if a new copy now exists for that logical shard. The original loop discarded `FollowerPass.more`, which could leave a quiet shard's replica behind after a large burst. The A1 regression exercises a partial feed page and a capped pass separately.
