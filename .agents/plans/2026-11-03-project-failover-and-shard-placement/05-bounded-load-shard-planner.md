# Bounded-load shard placement, and the decision record shrinks to its decisions
Job: Part 5 of the plan for the open failover and placement work (see 00-overview.md): phase 4 of the Effect Cluster decision (decision 6), and the last step of the whole job: the reference keeps only its decisions.
Date: 2026-11-03
Status: done
Verified-at: 53c038e024 (plus the uncommitted working tree of 2026-11-03)
Part: 5 of 5. Read 00-overview.md first.

To start:    Execute part 5 in .agents/plans/2026-11-03-project-failover-and-shard-placement/05-bounded-load-shard-planner.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-03-project-failover-and-shard-placement/05-bounded-load-shard-planner.md. Start with its section 8.

## Progress
- [x] 2026-11-03 1. A consistent-hash proposer with bounded loads
- [x] 2026-11-03 2. Shard reservations choose their Node with it
- [x] 2026-11-03 3. Docs and the placement contract
- [x] 2026-11-03 4. The decision record keeps only its decisions
- [x] 2026-11-03 5. Self-audit

## 0. Summary and finish line

When the App Data Fabric asks for a shard placement, the Platform reserves a Node for it
(`createAppShardPlacementAuthority`). Today it takes the first eligible Node by id, so every shard of every Project lands
on the same Node. Decision 6 says the proposal uses consistent hashing with virtual nodes, Node weights from capacity and a
load cap, so placements spread and move little when Nodes come and go; the reservation stays the committed record. This
part builds that proposer and uses it, and then removes the open-work list from the decision record.

**In scope:** a pure proposer in the Fabric core; its use in the reservation; tests; docs; shrinking the reference.
**Out of scope:** remote shard activation (prepare, copy, cutover, publication: 00-overview.md "Later"); any change to the
reservation's shape or authority.

**Done means:**
- **NEW** `packages/zelavis/src/core/fabric/bounded-load.ts` exports `proposeBoundedLoadNode`, pure and deterministic.
- `createAppShardPlacementAuthority` reserves the Node it proposes; `test/app-data-placement-contract.test.mjs` passes,
  with new cases for spread, cap, weight and movement.
- `effect-cluster-decision.md` has no "Phases" section and points at `.agents/plans/` for open work.
- `pnpm run verify` passes.

**Supplement:** see 00-overview.md.

## 1. Context packet

**Glossary**
- *Reservation*: `AppShardPlacementReservation` (`src/platform/app-data-placement.ts:53-66`): which Node an App shard is
  reserved on; no writer authority, never a routable target. One CAS ledger per Project (namespace
  `fabric.app-data-placement.v1`).
- *Eligible Node*: ready, in the Project allocation's `allowedNodeIds`, with enough CPU, memory and disk for the request
  (`app-data-placement.ts:218-223`).
- *Load*: the number of the Project's other reservations on a Node (from the ledger).
- *Bounded loads*: consistent hashing where a Node already at its cap is skipped and the walk continues around the ring
  (Mirrokni, Thorup, Zadimoghaddam, arXiv 1608.01350; Cluster uses the same, `effect-cluster-decision.md` "What Cluster is").

**Governing rules**
- Decision 6: "the planner proposes `shard → Node` with virtual nodes, Node weights from capacity, and a load cap, which
  minimises movement when Nodes come and go. The proposal is only a proposal: the Platform Fabric commits it as versioned,
  fenced placement" (`.agents/references/effect-cluster-decision.md`).
- "Core packages must remain portable and runtime-neutral" (`AGENTS.md § Runtime Independence Rule`): no `node:` import in `src/core`.
- "Pure synchronous calculations stay ordinary TypeScript." (`AGENTS.md § Effect Version`)
- "Document values, and anything a query compares or orders, use one order … Never `localeCompare`" applies to the
  database; for this ring order by number, then by id with plain `<` comparison, so the result is the same on every host.

**System today**
- `src/platform/app-data-placement.ts:169-265` `createAppShardPlacementAuthority`; the Node choice at `:218-225`:
  ```ts
  const eligible = ((yield* integrationValue(options.nodes()))).filter((node) =>
    node.ready && allocation.allowedNodeIds.includes(node.id) &&
    node.cpuCores >= request.resources.cpuCores &&
    node.memoryBytes >= request.resources.memoryBytes &&
    node.diskBytes >= request.resources.diskBytes,
  ).sort((a, b) => a.id.localeCompare(b.id));
  const node = eligible[0];
  if (!node) return (yield* integrationValue(refuse("no-eligible-node", revision)));
  ```
  `others` (`:212`) are the Project's other reservations; each has `nodeId`.
- `AppShardPlacementNode` (`:44-50`): `{ id, ready, cpuCores, memoryBytes, diskBytes }`.
- `test/app-data-placement-contract.test.mjs`: helpers `allocation`, `nodes`, `request(overrides)`, `authority(store, options)`
  (`:10-38`); the first case expects `node-a` when only `node-a` is allowed (`:44`).
- `src/core/fabric/index.ts`: the Fabric core (`zelavis/fabric`); `planFabricProjectPlacements` (`:442`) is the Project
  planner, separate from this.

**Pattern to mirror:** pure planning in `src/core/fabric/index.ts` (`planFabricProjectPlacements`, plain functions over
plain data, no Effect).

**Traps**
- `Math.random` or `Date.now` in the proposer: it must give the same answer for the same input everywhere.
- `node:crypto` for the hash in core: use a small pure hash (FNV-1a 32-bit) over the key's UTF-16 code units.
- Recomputing loads from anywhere but the ledger the reservation is written into: the ledger is the authority.
- Exporting the proposer from `zelavis/fabric`: keep it internal (imported by the Platform module); a public export would be
  a new public API with its own docs and parity duties.

## 2. Design

- **Proposer** (decided, pure TypeScript):
  - Input: `key` (`${projectId}\u0000${shardId}`), `nodes: { id, weight, load }[]` (already eligible).
  - Weight `w = min(8, max(1, round(weight)))`; ring points `64 × w` per Node at `fnv1a(\`${id}#${v}\`)`, sorted by point then
    id; the ring is built per call over the eligible Nodes only (at most 512 points per Node; 100 Nodes are
    51 200 points), which is the rare reservation path, not a request path.
  - Cap per Node `ceil(1.25 × (Σload + 1) × w / Σw)`. Start at the first point ≥ `fnv1a(key)` (wrapping), return the first
    Node whose `load < cap`. Since the caps sum to more than `Σload + 1`, a Node with room exists, so the walk ends within one
    turn of the ring; return `undefined` only for no Nodes.
- **Use:** in the reservation, `weight = node.cpuCores`, `load = others.filter((r) => r.nodeId === node.id).length`; the chosen id
  replaces `eligible[0]`. A repeated operation still returns its stored reservation first (`:205-210`), so a proposal never
  moves an existing reservation.
- **Invariants.** (1) Same input, same Node. (2) No Node's load exceeds its cap after the reservation. (3) The reservation
  record and its authority are unchanged.
- **Failure model.** Unchanged: no eligible Node → `no-eligible-node`.
- **Decisions and rejected alternatives.** FNV-1a: tiny, pure, good enough spread for ring placement; rejected SHA-256 through
  `crypto.subtle` (asynchronous, unneeded strength). Load factor 1.25 and 64 points per weight unit follow the paper's and
  Cluster's common settings; rejected rendezvous hashing (decision 6 names consistent hashing with bounded loads).

## 3. Contracts

```ts
// packages/zelavis/src/core/fabric/bounded-load.ts  (NEW, internal)
export interface BoundedLoadNode {
  readonly id: string;
  /** Capacity weight; rounded and clamped to 1–8. */
  readonly weight: number;
  /** Placements the Node already holds for this group. */
  readonly load: number;
}
export const BOUNDED_LOAD_FACTOR = 1.25;
export const BOUNDED_LOAD_POINTS_PER_WEIGHT = 64;
export const BOUNDED_LOAD_MAX_WEIGHT = 8;
/** The Node `key` goes to: consistent hashing with bounded loads. Pure and deterministic. */
export function proposeBoundedLoadNode(key: string, nodes: readonly BoundedLoadNode[]): string | undefined;
```
No route, SDK or CLI change.

## 4. Execution steps

### Step 1. A consistent-hash proposer with bounded loads
- **Files:** **NEW** `packages/zelavis/src/core/fabric/bounded-load.ts`, **NEW** `packages/zelavis/test/fabric-bounded-load.test.mjs`.
- **Change:** section 2 and 3. No imports beyond none (pure). Validate input: ids non-empty and unique (throw `TypeError` on a
  duplicate id; the caller passes Nodes from one inventory), `load` a non-negative safe integer, `weight` finite.
- **Tests** (import from `../dist/core/fabric/bounded-load.js`):
  - deterministic: the same call twice gives the same id; the order of `nodes` does not change the answer;
  - spread: 4 Nodes of weight 1, 400 keys placed one after another with loads updated after each: every Node ends with at
    most `ceil(1.25 × 400 / 4)` = 125, and at least 50;
  - weight: Nodes of weight 4 and 1, 500 keys placed: the heavy one ends with more than 300;
  - movement: with loads 0, propose 1 000 keys for 4 Nodes, then for 5 (one added): at most 350 proposals change (the ideal is
    about 200);
  - edge: no Nodes → `undefined`; a duplicate id throws.
- **Check:** build; from `packages/zelavis`: `node --test test/fabric-bounded-load.test.mjs; echo "exit $?"` → `exit 0`.

### Step 2. Shard reservations choose their Node with it
- **Files:** `packages/zelavis/src/platform/app-data-placement.ts`, `packages/zelavis/test/app-data-placement-contract.test.mjs`.
- **Change:** replace the `.sort(...)` and `eligible[0]` of `:218-225` with:
  ```ts
  const eligible = (...filter as today...);
  const nodeId = proposeBoundedLoadNode(`${request.projectId}\u0000${request.shardId}`, eligible.map((node) => ({
    id: node.id, weight: node.cpuCores, load: others.filter((entry) => entry.nodeId === node.id).length,
  })));
  const node = eligible.find((entry) => entry.id === nodeId);
  if (!node) return (yield* integrationValue(refuse("no-eligible-node", revision)));
  ```
  Import: `import { proposeBoundedLoadNode } from "../core/fabric/bounded-load.js";`.
- **Tests:** existing cases pass unchanged (single allowed Node). New case: an allocation allowing 3 equal Nodes and budget for
  30 shards; reserve 30 shards (`shardId: \`shard-${n}\``, fresh `operationId`, `expectedRevision` from the previous answer);
  assert every Node holds between 5 and 13 (cap `ceil(1.25 × 30 / 3)` = 13), and that repeating the first request returns
  its original Node.
- **Check:** build; `node --test test/app-data-placement-contract.test.mjs test/fabric-bounded-load.test.mjs; echo "exit $?"` → `exit 0`.

### Step 3. Docs and the placement contract
- **Files:** `.agents/references/two-fabrics-placement-contract.md` (status paragraph, `:3-13`: reservations now spread by
  bounded-load consistent hashing; activation still not implemented); the public Fabric/placement architecture page
  (`grep -rln "app-data-placement\|shard placement" website/src/content/docs | head`; if none mentions shard reservations, add
  nothing public, since reservations have no public surface).
- **Check:** `pnpm run docs:check; echo "exit $?"` from the root → `exit 0`.

### Step 4. The decision record keeps only its decisions
- **Files:** `.agents/references/effect-cluster-decision.md`; `.agents/plans/2026-11-03-project-failover-and-shard-placement/00-overview.md`.
- **Precondition:** parts 1–4 are `done` in `00-overview.md`. If one is not, do not do this step: mark this part `partly done`
  and report it; the step runs when the last of them is done.
- **Change:** delete the whole `## Phases` section. Replace the `Status:` paragraph at the top with:
  `Status: **decided 2026-10-31** (delegated decision), and built: durable entities, durable Workloads, writer leases and
  follower failover, standby Projects and bounded-load shard reservations. Open work, if any, lives in \`.agents/plans/\`.`
  Keep `## Decisions` and `## Not doing` word for word. Check that nothing links to the removed section:
  `grep -rn "effect-cluster-decision.md#phases\|Phases section" AGENTS.md .agents website/src/content/docs` → no output.
  In `00-overview.md`, set this part's row to `done`; set the overview's `Status` to `done` only if its owner-only and "Later"
  lists are empty, otherwise to `partly done`, so the plan-writer cleanup keeps the overview while open items remain.
- **Check:** `pnpm run docs:check; echo "exit $?"` → `exit 0`.

### Step 5. Self-audit
See section 8. From the root: `pnpm run verify; echo "exit $?"` → `exit 0`.

## 5. Tests
`fabric-bounded-load.test.mjs`: determinism, spread, cap, weight, movement, edge cases (step 1).
`app-data-placement-contract.test.mjs`: spread across eligible Nodes within the cap, a repeated request keeps its Node (step 2).
No dashboard change, so no browser test.

## 6. Docs and project notes
Steps 3 and 4. No `pnotes/` change.

## 7. Verification
From the root: `pnpm run verify; echo "exit $?"` → `exit 0`; `pnpm run docs:check` → `exit 0`.

## 8. Instructions to the implementer

> **Before changing anything, read `Status` and `## Progress`.**
> - Compare `Verified-at` with `HEAD`; check each quoted excerpt you rely on before its step and stop and report when one no
>   longer matches. `Status: needs replanning` means stop at once.
> - `Status: planned`: set `Status: in progress` here and in `00-overview.md`. Anything else: you are continuing; read every
>   `## Execution report` entry, confirm the last `[x]` check still passes, finish or redo the `[~]` step, never redo `[x]`.
> - `Status: in progress` and you were asked to *execute*: stop and ask the user.
>
> Read the earlier parts' execution reports; step 4 waits for parts 1–4 to be done. If a deviation there affects this part,
> stop and report.
>
> **Keep `## Progress` current** (`[~]` with date before the first edit, `[x]` with date and note after its check passed).
> Build before tests (`pnpm --filter zelavis run build`; exit 0 with no `error TS`). zsh: `; echo "exit $?"`.
>
> Read section 1 first and return to it when unsure. Steps in order; tests run in the step that writes them. Do not redesign or
> improve beyond the plan; match the surrounding style.
>
> **Stop and report instead of improvising** when a cited symbol differs, a check fails for a reason that is not a simple
> mistake in your change, a test's bound fails (that is a finding about the proposer, not a bound to loosen), a gate would need
> a suppression, baseline entry, wrapper or shim, or the plan seems to contradict `AGENTS.md` (which wins).
>
> **An unexpected result is a finding, never noise**: investigate it in this session until you know its cause; fix it if it stays
> in this part's files and rules, otherwise report the cause and your proposed fix.
>
> Never: `node:` imports or Effect in `bounded-load.ts`, `Math.random`, `Date.now` or `localeCompare` in the proposer,
> compatibility aliases or fallbacks, silent catches, unbounded loops (the walk is bounded by one turn of the ring), anything in
> `.claude/` or `pnotes/`, edits to `dist/`, `website/dist/`, `website/.astro/` or `repos/effect/`. Never touch other people's
> uncommitted files. Do not commit, push or publish.
>
> **Self-audit before you report done** (step 5): re-read the diff against sections 1–5; check each Done means item; rerun the
> tests this part touched and `pnpm run verify` after your last edit; search the diff for forbidden patterns, debug output,
> TODOs; every unexpected result has a known cause. Record the audit.
>
> When you finish or stop, add `### Session <n>: <date>` under `## Execution report`: final status (update `Status` here and in
> `00-overview.md`), each step one line, verification results (including the spread numbers of steps 1 and 2), deviations and
> why, anything undone, **Context the plan lacked** ("none" if nothing). Then give the user the same report, shortened.

## Execution report

### Session 1: 2026-11-03
Status: done.
- Step 1: `src/core/fabric/bounded-load.ts` (`proposeBoundedLoadNode`; pure, FNV-1a, 64 ring points per weight unit up to 8, cap `ceil(1.25 × (Σload + 1) × w / Σw)`, one turn of the ring at most) and `test/fabric-bounded-load.test.mjs`. Measured: 400 keys over 4 equal Nodes → 56, 96, 123, 125 (cap 125); weights 4:1 over 500 keys → heavy 485, light 15; a fifth Node joining moved 154 of 1000 proposals (bound 350).
- Step 2: `createAppShardPlacementAuthority` reserves the proposed Node (`weight` = CPU cores, `load` = the Project's other reservations on it, from the ledger); new case in `app-data-placement-contract.test.mjs`: 30 shards over 3 Nodes → node-b 9, node-a 8, node-c 13 (cap 13); asking again keeps the recorded Node.
- Step 3: `.agents/references/two-fabrics-placement-contract.md` status paragraph. No public page mentions shard reservations, so no public doc changed.
- Step 4: parts 1–4 were done; `## Phases` removed from `effect-cluster-decision.md`, its status line replaced, `## Decisions` and `## Not doing` untouched; nothing links to the removed section. The reference's two open phase-3 items (the VPS run, the Platform's own failover) are the overview's owner-only items.
- Step 5: `pnpm run verify` exit 0; `pnpm run docs:check` exit 0; the proposer has no `node:` import, Effect, `Math.random`, `Date.now` or `localeCompare`.

Deviations: none. Overview Status is `partly done`: its owner-only items (the VPS failover drill, the Platform's own failover decision) and its "Later" items (remote App shard activation, routing to a remotely placed Project, a new standby after a failover) are open.
Context the plan lacked: none.
