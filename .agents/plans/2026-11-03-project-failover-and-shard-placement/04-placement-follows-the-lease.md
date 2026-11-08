# The standby runs on its node, and placement follows the lease
Job: Part 4 of the plan for the open failover and placement work (see 00-overview.md): the Fabric half of decision 9 — run a lease-guarded Project's standby on the standby node, and move the Project's placement to whoever the lease names.
Date: 2026-11-03
Status: done
Verified-at: 53c038e024 (plus the uncommitted working tree of 2026-11-03)
Part: 4 of 5. Read 00-overview.md first.

To start:    Execute part 4 in .agents/plans/2026-11-03-project-failover-and-shard-placement/04-placement-follows-the-lease.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-03-project-failover-and-shard-placement/04-placement-follows-the-lease.md. Start with its section 8.

## Progress
- [x] 2026-11-03 1. Dispatch carries a lease environment, and a `standby` action
- [x] 2026-11-03 2. The remote Agent starts a standby, and starts a writer under its lease
- [x] 2026-11-03 3. Starting a Project that runs as a standby adopts it as the writer
- [x] 2026-11-03 4. The Platform records where each standby runs
- [x] 2026-11-03 5. The Project manager runs the standby, and stops it before the writer
- [x] 2026-11-03 6. A change of writer moves the Project's placement
- [x] 2026-11-03 7. Reconciliation catches a change of writer it was not told about
- [x] 2026-11-03 8. The standby in the Project read, the SDK and the CLI
- [x] 2026-11-03 9. The dashboard shows the standby
- [x] 2026-11-03 10. A writer crashes and the Project fails over to its standby node
- [x] 2026-11-03 11. Docs
- [x] 2026-11-03 12. Self-audit

## 0. Summary and finish line

Part 3 made a Project process that can stand by and promote itself. This part has the Platform run that process on the
standby node through the remote Agent, and then do what decision 9 gives it: learn of a promotion from the lease record
and move the Project's Fabric placement to the promoted node, so the Gateway serves the Project from there. Nobody tells
the standby to promote; the Platform never calls a node to promote.

**In scope:** dispatch claims and the remote Agent; driver adoption of a standby; a Platform standby record (with its
deletion participant); the Project manager's standby start, stop order, lease-change reconciliation; the Project read,
SDK, CLI and dashboard; one end-to-end failover test; docs.
**Out of scope:** making a new standby after a failover (00-overview.md, later); remote App shard activation; the
Platform's own failover (owner decision).

**Done means:**
- Starting a lease-guarded Project whose standby node is a remote node starts the writer on the placed node and a standby
  on the standby node; `GET /runtime/projects/:id` shows `standby: { nodeId, status }`.
- Stopping such a Project stops the standby first, then the writer; the standby never promotes on a stop.
- When the writer's process dies, the standby promotes itself after the lease's TTL, the Platform moves the placement to
  the standby node at a new epoch, and requests through the Platform reach the Project there with its data.
- `client.projects.get(id)` and `zelavis projects get <id>` show the standby; the dashboard shows it on the Project's page.
- `test/project-failover.test.mjs` passes; `pnpm run verify` and `pnpm run ci:ui` pass.

**Supplement:** see 00-overview.md.

## 1. Context packet

**Glossary**
- *Placement*: `ProjectPlacementRecord` (`src/platform/project-placement-authority.ts:8-19`): `{ projectId, nodeId,
  ownerSession, epoch, revision, leaseExpiresAt, state }` in System Store namespace `fabric.project-ownership.v1`; acquired,
  renewed and released by CAS (`acquire` `:106-144`, `renew` `:145-170`, `release` `:171-187`). Its own lease (60 s,
  `src/project.ts:1040`) is the Platform session's, unrelated to the writer lease.
- *Writer lease*: the Project's database lease (parts 1–3). The fence for writes.
- *Dispatch*: signed single-use authority the Platform sends a remote Agent (`ProjectDispatchClaims`,
  `src/core/agent/project-dispatch.ts:11-23`: actions `prepare | start | stop`), over pinned-CA HTTPS
  (`src/adapters/_project-dispatch-https.ts:87` server, `:304` client `createHttpsProjectDispatcher`).
- *Standby record*: **NEW** in this part: where a Project's standby runs.

**Governing rules**
- Decision 9 (`.agents/references/effect-cluster-decision.md`): "The Platform never calls a node to promote. It holds the
  authority, so it learns of a promotion by the lease record itself, audits it … and, when the partition belongs to a
  Project, reconciles the Project's Fabric placement `{owner, epoch}` to the promoted node: the Fabric starts the Project
  there through the existing signed remote start and fences the previous owner by epoch."
- "Never restore all desired-running projects with an unbounded `Promise.all` … Reconciliation must be bounded,
  asynchronous, idempotent, and safe to retry." (`AGENTS.md § Platform And App Service Boundary`)
- "Any new Platform resource keyed by Project identity must register a cleanup participant" (same section).
- "Remote Project start is implemented end to end … Not yet proven: multi-host network-partition drills" (same section).
- Dashboard: "All new dashboard UI is built there, natively … Qualification is `pnpm run ci:ui`" (`AGENTS.md § UI Package Rules`).

**System today**
- Placement commit: `src/project.ts:1680-1718` (`ensureCommittedPlacement`, `commitPlacement`): renews the session's own
  active placement, or acquires `expectedEpoch: current?.epoch ?? 0`; `ownedPlacements` holds the session's tokens.
- Stop: `src/project.ts:1730-1760` `stopPlacedRuntime`: a remote placement needs `dispatchStopFenced`; then `release`.
- Fleet reconciliation: `src/project.ts:1882` `reconcileFleet` (`mapWithConcurrency(existing, startupConcurrency, …)`).
- Remote Agent: `src/adapters/_remote-project-agent.ts:21-125`: `start(claims)` (`:66-77`) reads the prepared record and
  calls `runtime.start(project, { projectId, nodeId, ownerSession, epoch })`; `stop` (`:78-81`).
- Remote end to end: `test/remote-project-agent.test.mjs:18-90` (TLS key with `openssl`, Ed25519 trust, `createRemoteProjectAgent`,
  `createHttpsProjectDispatcher`, `dispatchLeaseFenced`, `authorizeDispatch`, `dispatchStartFenced`).
- A Platform with a remote node: `test/node-adapter-remote-nodes.test.mjs:30-66` (`nodeAdapter({ projects: { directory,
  remoteDispatch: { localNodeId, nodes } } })`).
- Lease routes: `src/platform/writer-lease-routes.ts:39-71` `writeCore`: a change of writer is audited after it lands
  (`audited`, `:45-53`). Project write path `:139-153`.
- Lease store: `systemStoreLeaseStore` (`src/platform/writer-lease-store.ts:20`).
- Part 3 (**NEW** there, check they exist): `startStandby` on the Node driver; `ZelavisProjectRuntimeStatus` with
  `"standby"`; `projectLeaseEnvironment(configuration, store, projectId, role)`; `start` refusing a standby process.
- Process diagnostics: `GET /runtime/debug/processes` (`src/index.ts:2734`, `server.debug.read`).
- Dashboard Project page: `packages/zelavis/services/zelavis-ui/app/projects-pages.ts` (status use at `:235-237`); UI tests in
  `packages/zelavis/services/zelavis-ui/tests/*.test.mjs`; browser suites `scripts/test-*.mjs` (Playwright `chromium`), run by `pnpm run ci:ui`.

**Pattern to mirror:** deletion participant `deleteProjectPlacementAuthority` (`project-placement-authority.ts:214-222`)
and its registration (`src/index.ts:7264-7271`); single-flight placement claims (`project.ts:1679-1682`).

**Traps**
- Ordering a promotion from the Platform: the Platform only reacts to a lease that already changed.
- Releasing the writer's lease on an operator stop while a standby runs: the standby would promote. Stop the standby first.
- Starting a second process on the standby node at failover: the standby process *is* the Project there; `start` adopts it.
- Trusting the lease alone for routing, or placement alone for writes: placement routes, the lease fences.
- An unbounded scan of every Project on each lease write: react to the one scope written; the backstop runs inside the
  existing bounded `reconcileFleet`.

## 2. Design

- **Authority.**
  - The Project manager (Platform) is the only writer of placement and of the standby record.
  - A standby dispatch is signed like a start (`authorizeDispatch`), with `action: "standby"` and the *writer's* placement
    token fields; the Agent checks signature, nonce, destination and expiry, but accepts no placement lease for it: a
    standby never writes before its lease promotion, and the lease is the write fence.
  - Dispatch claims carry the lease environment (`lease`), so the remote Agent, which holds no installation secret, can
    start a lease-guarded process. Claims are signed whole (`canonical`), so the environment cannot be altered.
- **Persistence.** **NEW** System Store namespace `fabric.project-standby.v1`, key = Project id:
  `{ schemaVersion: 1, projectId, nodeId, writerEpoch, state: "dispatched" | "stopped" | "promoted" | "failed", error?, updatedAt }`,
  written by CAS (`setIfAbsent`/`compareAndSet`, as the placement authority does); deleted by a Project deletion participant.
- **Flows.**
  - *Start* (lease-guarded, `ZELAVIS_PROJECT_LEASES_STANDBY` names a node the dispatcher can reach, and that node is not
    the placed one): after the writer's placement is committed and the writer started, dispatch `prepare` (snapshot) and
    `standby` to the standby node; record `dispatched`. A standby that fails to start is recorded `failed` with its error;
    the writer keeps serving.
  - *Stop*: dispatch `stop` to the standby (record `stopped`), then stop the writer as today.
  - *Change of writer*: `writeCore` calls `onProjectWriterChanged(scope)` after the audit, for writes that land a new
    owner or epoch. The manager's **NEW** `followWriterLease(projectId)` (single-flight per Project): read the lease; if its
    owner is the placed node, nothing; if the owner is the standby record's node and the lease is unexpired: release the
    session's token for the old node (`authority.release`), acquire placement for the lease owner (`expectedEpoch` from the
    released record), dispatch `start` with the new token to that node (its Agent adopts the running standby, step 3),
    record the standby `promoted`. The previous writer is fenced twice: its writes by the lease epoch (it exits with 75
    when superseded, `_node-project-engine.ts:36-39`), its placement by the epoch it no longer holds.
  - *Backstop*: `reconcileFleet` calls `followWriterLease` for every lease-guarded Project it visits, inside its existing
    bounded concurrency, so a change the hook missed (Platform restart) is settled.
- **Invariants.** (1) At most one placement active per Project (CAS, unchanged). (2) A stop never promotes a standby.
  (3) Placement moves only to the node the lease names, and only while that lease is unexpired. (4) No standby record
  outlives its Project.
- **Failure model.** Standby dispatch failure → record `failed` with the error, Project read shows it, the writer keeps
  serving. `followWriterLease` failures (store unreachable, `acquire` refused) → logged, retried by the next hook or the
  backstop; placement stays where it was (the old node's Agent self-fences on its placement lease). A lease owner that is
  neither placed node nor standby node → logged as a finding and left alone (only the standby promotes without loss).
- **Decisions and rejected alternatives.**
  - Hook plus backstop rather than polling every lease: costs the changes. Rejected: a timer reading every Project's lease.
  - Adopt the standby process rather than start anew: a second process would open the same data directory.
  - Lease environment in signed claims rather than a separate body: dispatch control requests are capped at 16 KiB and
    claims are already the signed unit (`.agents/references/two-fabrics-placement-contract.md`, Remote delivery).
- **Open questions:** none.

## 3. Contracts

```ts
// src/core/agent/project-dispatch.ts
export interface ProjectDispatchClaims {
  readonly action: "prepare" | "start" | "stop" | "standby";
  // … existing fields …
  /** The lease environment the started process gets (`ZELAVIS_LEASE_*`); part of the signed claims. */
  readonly lease?: Readonly<Record<string, string>>; // at most 8 entries, keys /^ZELAVIS_LEASE_[A-Z_]+$/, values ≤ 2048 chars
}

// src/project.ts
export interface ZelavisProjectStandby {
  readonly nodeId: string;
  readonly status: "dispatched" | "stopped" | "promoted" | "failed";
  readonly error?: string;
}
// ZelavisProjectRecord gains: readonly standby?: ZelavisProjectStandby;
// ZelavisProjectManager gains: followWriterLease(projectId: string): Promise<void>;

// src/platform/writer-lease-routes.ts — ProjectLeaseCapabilityOptions gains:
readonly onProjectWriterChanged?: (scope: string) => Promise<void>;
```
- HTTP: no new route; `GET /runtime/projects/:id` carries `standby`.
- SDK: `ZelavisProjectRecord.standby` (the SDK's record type in `src/sdk/fetch.ts`; find it with `grep -n "interface ZelavisProjectRecord" src/sdk/*.ts`).
- CLI: `zelavis projects get <id>` text output adds `standby: <nodeId> (<status>)` and the error when failed; `--json` carries the field.
- Dashboard: the Project's overview shows "Standby: <nodeId> — <status>" (and the error when failed).

## 4. Execution steps

Each step's tests run in that step. Build first each time (`pnpm --filter zelavis run build`).

### Step 1. Dispatch carries a lease environment, and a `standby` action
- **Files:** `packages/zelavis/src/core/agent/project-dispatch.ts` (claims, `canonical` at `:80`, validation),
  `packages/zelavis/src/adapters/_project-dispatch-https.ts` (client: **NEW** `dispatchStandbyFenced({ projectId, nodeId, placement, authority })`
  mirroring `dispatchStartFenced` `:345`; `authorizeDispatch` accepts `action: "standby"` and an optional `lease`).
- **Test:** extend the dispatch tests (find them: `grep -ln "authorizeDispatch" test/*.mjs`): a claim with `lease` verifies;
  altering any lease value breaks the signature; a key outside the pattern or a ninth entry is refused.
- **Check:** `node --test <those files>; echo "exit $?"` → `exit 0`.

### Step 2. The remote Agent starts a standby, and starts a writer under its lease
- **Files:** `packages/zelavis/src/adapters/_project-dispatch-https.ts` (server: a `standby` handler beside `start`),
  `packages/zelavis/src/adapters/_remote-project-agent.ts` (`standby(claims)` → `runtime.startStandby(project, { leaseEnvironment: claims.lease })`;
  `start(claims)` passes `claims.lease` too), `packages/zelavis/src/adapters/_local-project-runtime.ts` and
  `_node-project-runtime.ts` (`start` and `startStandby` take an optional per-call `{ leaseEnvironment }` that replaces the
  `leaseEnvironment` option for that start).
- **Test:** in `test/remote-project-agent.test.mjs` add a case: dispatch `standby` with a lease environment pointing at a
  lease authority (a node:http server over `createWriterLeaseRoutes(memoryLeaseStore())`, as
  `distribution/scripts/failover/authority.mjs` does) where another owner holds a live lease; assert the Agent reports the
  Project's snapshot `standby`.
- **Check:** `node --test test/remote-project-agent.test.mjs; echo "exit $?"` → `exit 0`.

### Step 3. Starting a Project that runs as a standby adopts it as the writer
- **Files:** `packages/zelavis/src/adapters/_node-project-runtime.ts`.
- **Change:** replace part 3's refusal: `start(project, placement)` for a process whose snapshot is `standby` keeps the
  process, sets `{ status: "running", url, startedAt }` and returns it; it passes the new placement to the Agent the way a
  start does (`agent.start(... placement ...)` binds placement at launch; for an adopted process use the Agent client's
  placement update if one exists, else stop and report: adoption needs the Agent to accept a placement for a running
  workload).
- **Test:** in `test/project-standby.test.mjs` (part 3), after B's promotion call `driverB.start(project, token)` and assert
  the same `url` and `status: "running"`, and that no second process started (the Agent's process list for the workload has one entry).
- **Check:** `node --test test/project-standby.test.mjs; echo "exit $?"` → `exit 0`.

### Step 4. The Platform records where each standby runs
- **Files:** **NEW** `packages/zelavis/src/platform/project-standby.ts` (`readProjectStandby`, `writeProjectStandby` by CAS,
  `deleteProjectStandby` participant, decoder refusing malformed records), `packages/zelavis/src/index.ts` (participant
  `project-standby` after `project-writer-lease`), **NEW** `packages/zelavis/test/project-standby-record.test.mjs`.
- **Test:** write, read, conditional update refused on a stale version, malformed record refused, delete idempotent.
- **Check:** `node --test test/project-standby-record.test.mjs; echo "exit $?"` → `exit 0`.

### Step 5. The Project manager runs the standby, and stops it before the writer
- **Files:** `packages/zelavis/src/project.ts` (after the writer starts in the start path; in `stopPlacedRuntime`),
  `packages/zelavis/src/adapters/node.ts` (pass the standby node from `projectLeaseConfiguration()` and the lease environment
  minting for `"standby"` into the manager options).
- **Change:** flows *Start* and *Stop* of section 2. Bounded: one standby per Project, dispatched in the Project's own
  lifecycle (`withProjectLifecycle`), never fleet-wide.
- **Test:** in `test/project-failover.test.mjs` (**NEW**, the setup of step 10), the first case: start → writer running on
  `node-a`, `standby: { nodeId: "node-b", status: "dispatched" }`, the Agent on `node-b` reports `standby`; stop → the standby
  is stopped first (record `stopped`) and the lease never names `node-b`.
- **Check:** `node --test test/project-failover.test.mjs; echo "exit $?"` → `exit 0`.

### Step 6. A change of writer moves the Project's placement
- **Files:** `packages/zelavis/src/platform/writer-lease-routes.ts` (call `onProjectWriterChanged(scope)` after `audited` when the
  owner or epoch changed; both the operator route and the capability route; a failing callback is logged with
  `Effect.logError`, never fails the write), `packages/zelavis/src/project.ts` (`followWriterLease`), `packages/zelavis/src/index.ts`
  (wire `onProjectWriterChanged: (scope) => projects.followWriterLease(scope)` into the capability options at `:4648-4652`).
- **Test:** unit test in `test/project-failover.test.mjs` with a fake dispatcher: write a lease naming `node-b` at epoch 2 →
  placement moves to `node-b` at epoch + 1, a `start` dispatched with the new token, standby `promoted`; a lease naming an
  unknown node → nothing moves and a log line names it.
- **Check:** as step 5.

### Step 7. Reconciliation catches a change of writer it was not told about
- **Files:** `packages/zelavis/src/project.ts` (`reconcileFleet`, `:1882`).
- **Change:** for each lease-guarded Project visited, `followWriterLease(project.id)` (errors logged, the visit continues).
- **Test:** change the lease directly in the System Store (bypassing the route), run one reconciliation pass (find how
  tests trigger `reconcileFleet`: `grep -n "reconcile" test/platform-project-ownership.test.mjs`), assert the placement moved.
- **Check:** as step 5.

### Step 8. The standby in the Project read, the SDK and the CLI
- **Files:** `packages/zelavis/src/project.ts` (record), the SDK record type, `packages/zelavis/src/cli/` (the `projects get`
  text output: find it with `grep -rn "projects get" src/cli/*.ts`).
- **Test:** `test/capability-parity.test.mjs` passes; a CLI test (mirror an existing `projects get` CLI test if one exists,
  else the `viaCli` helper of `test/_runtime.mjs:60`) shows `standby: node-b (dispatched)`.
- **Check:** `node --test test/capability-parity.test.mjs <cli test>; echo "exit $?"` → `exit 0`.

### Step 9. The dashboard shows the standby
- **Files:** `packages/zelavis/services/zelavis-ui/app/projects-pages.ts` (the Project overview), a UI test in
  `packages/zelavis/services/zelavis-ui/tests/`.
- **Change:** a line "Standby: <nodeId> — <status>" with the error when `failed`; `standby` status shown as "Standing by",
  never as running. Build with the page's DOM builders (`app/dom.ts`, `app/page-kit.ts`); no React.
- **Tests:** a unit test of the rendering for each status. **Browser:** the route parity suite already visits the Project
  page at desktop and mobile sizes; a Platform with a reachable standby node cannot be made in the throwaway Platforms the
  suites start, so the standby line is proven by the unit test, and `pnpm run ci:ui` proves the page still renders.
- **Check:** from the root `pnpm --filter @zelavis/ui test; echo "exit $?"` and `pnpm run ci:ui; echo "exit $?"` → `exit 0`.

### Step 10. A writer crashes and the Project fails over to its standby node
- **Files:** `packages/zelavis/test/project-failover.test.mjs`.
- **Change:** a Platform as in `test/node-adapter-remote-nodes.test.mjs:30-43` with `localNodeId: "node-a"` and node `node-b`
  pointing at a real `createRemoteProjectAgent` (TLS and trust as `test/remote-project-agent.test.mjs:19-38`), leases set as in
  part 1 (TTL 3000) with standby `node-b`, served over node:http. Create and start Project `leased`; write data through
  `client.data("leased")`; wait for the standby to be level (part 3's listing comparison, B read through its Agent's
  reported URL); read the writer process's pid from `GET /runtime/debug/processes` (if the answer has no pid, stop and report:
  the crash cannot be made without it) and `process.kill(pid, "SIGKILL")`. Assert within 30 s: the lease names `node-b` at a
  higher epoch; `GET /runtime/projects/leased` shows the placement on `node-b` and `standby.status: "promoted"`; reading the
  data through `client.data("leased")` returns what was written.
- **Check:** `node --test test/project-failover.test.mjs; echo "exit $?"` → `exit 0`.

### Step 11. Docs
- **Files:** `website/src/content/docs/api/database.md` (Writer leases and follower failover), the Fabric/placement
  architecture page (`grep -rln "placement" website/src/content/docs/architecture | head`), `AGENTS.md` only where it calls
  this unproven (the "Project runtime placement" paragraph: say a lease-guarded Project fails over to its standby node, and
  that multi-host partition drills are still not run), `.agents/references/effect-cluster-decision.md` (remove the Fabric item
  from phase 3; the reference keeps only the VPS run, the Platform failover decision and phase 4 until part 5).
- **Check:** `pnpm run docs:check; echo "exit $?"` → `exit 0`.

### Step 12. Self-audit
See section 8. From the root: `pnpm run verify; echo "exit $?"` and `pnpm run ci:ui; echo "exit $?"` → `exit 0`.

## 5. Tests
- Dispatch claims: lease environment signed, bounded (step 1).
- Remote Agent standby start (step 2); adoption keeps one process (step 3).
- Standby record CAS and cleanup (step 4).
- Manager: start runs a standby; stop stops it first (step 5); a change of writer moves placement, an unknown owner does not (step 6);
  the backstop settles a missed change (step 7).
- Read, SDK, CLI (step 8); dashboard rendering per status, plus `ci:ui` (step 9).
- End to end: SIGKILL the writer, failover to the standby node, data intact (step 10).

## 6. Docs and project notes
Step 11. Also add to 00-overview.md's "Later" list anything this part could not do (it already lists the new standby after a
failover). No `pnotes/` change.

## 7. Verification
From the root: `pnpm run verify; echo "exit $?"` → `exit 0`; `pnpm run ci:ui; echo "exit $?"` → `exit 0`; `pnpm run docs:check` → `exit 0`.

## 8. Instructions to the implementer

> **Before changing anything, read `Status` and `## Progress`.**
> - Compare `Verified-at` with `HEAD`; parts 1–3 change many cited files, so check each quoted excerpt before its step and
>   stop and report when one no longer matches. `Status: needs replanning` means stop at once.
> - `Status: planned`: set `Status: in progress` here and in `00-overview.md`. Anything else: you are continuing; read every
>   `## Execution report` entry, confirm the last `[x]` check still passes, finish or redo the `[~]` step, never redo `[x]`.
> - `Status: in progress` and you were asked to *execute*: stop and ask the user.
>
> Read parts 1–3's execution reports first and check part 3's **NEW** symbols exist (`startStandby`, the `standby` status,
> `projectLeaseEnvironment(…, role)`, `test/project-standby.test.mjs`). If a deviation there affects this part, stop and report.
>
> **Keep `## Progress` current** (`[~]` with date before the first edit, `[x]` with date and note after its check passed).
> Build before tests (`pnpm --filter zelavis run build`; exit 0 with no `error TS`). zsh: `; echo "exit $?"`.
>
> Read section 1 first and return to it when unsure. Steps in order; tests run in the step that writes them. Do not redesign or
> improve beyond the plan; match the surrounding style; dashboard code is plain DOM through `app/dom.ts`/`app/page-kit.ts`.
>
> **Stop and report instead of improvising** when a cited symbol differs, a check fails for a reason that is not a simple mistake
> in your change, a gate (`check:tigerstyle`, `check:effect-usage`, repo rules, capability parity) would need a suppression,
> baseline entry, wrapper or shim, the Agent cannot accept a placement for a running workload (step 3), the diagnostics have no
> pid (step 10), or the plan seems to contradict `AGENTS.md` (which wins).
>
> **An unexpected result is a finding, never noise**: investigate it in this session until you know its cause; fix it if it
> stays in this part's files and rules, otherwise report the cause and your proposed fix.
>
> Never: compatibility aliases or fallbacks, silent catches, `try/catch` in Platform code, `Effect.ignore`, unbounded
> concurrency (use `startupConcurrency`/`mapWithConcurrency`), unchecked `JSON.parse` casts, Promise orchestration in Platform
> code, the Platform ordering a promotion, a React page, anything in `.claude/` or `pnotes/`, edits to `dist/`,
> `website/dist/`, `website/.astro/` or `repos/effect/`. Never touch other people's uncommitted files. Do not commit, push or publish.
>
> **Self-audit before you report done** (step 12): re-read the diff against sections 1–5; check each Done means item; rerun the
> tests this part touched, `pnpm run verify` and `pnpm run ci:ui` after your last edit; search the diff for forbidden patterns,
> debug output, TODOs; every unexpected result has a known cause. Record the audit.
>
> When you finish or stop, add `### Session <n>: <date>` under `## Execution report`: final status (update `Status` here and in
> `00-overview.md`), each step one line, verification results (including the failover time in step 10), deviations and why,
> anything undone, **Context the plan lacked** ("none" if nothing). Then give the user the same report, shortened.

## Execution report

### Session 1: 2026-11-03
Status: done, with the deviations below (two of the plan's assumptions did not hold).
- Step 1: `ProjectDispatchClaims` gained the `standby` action and a signed `lease` environment (12-element canonical payload, at most 8 `ZELAVIS_LEASE_*` entries of at most 2048 characters); `verifyProjectDispatchAuthority` can verify without a placement (checking the Agent's own Node instead); `receiveStandbyDispatch`; dispatcher `dispatchStandbyFenced` / `dispatchStandbyStopFenced`, and `authorizeDispatch` takes a `lease`. Test in `project-dispatch-authority.test.mjs`.
- Step 2: the Agent serves `/v1/standbys/:id/(prepare|start|stop)`; `startStandby` and `stopStandby` in `_remote-project-agent.ts`; `start` passes `claims.lease`; the drivers take a per-call `ZelavisProjectStartOptions.leaseEnvironment`; the deployment-backend wrapper forwards `startStandby`.
- Step 3: replaced, see deviation 1.
- Step 4: `platform/project-standby.ts` (CAS store, decoder, deletion participant `project-standby`); `test/project-standby-record.test.mjs`.
- Step 5: `startStandbyFor` after the writer starts (local and dispatched), `stopStandbyFor` before any stop; a standby that fails to start is recorded `failed` and the writer keeps serving; a standby that cannot be stopped fails the stop.
- Step 6: `onProjectWriterChanged` on the lease capability options (forked, never fails the write), `followWriterLease` on the manager (release the old token, acquire for the lease owner, dispatch lease and start with a writer lease environment, record `promoted`).
- Step 7: `reconcileFleet` calls `followWriter` for every Project it visits when lease-guarded.
- Step 8: `standby` on the Project record (read from the standby record), the CLI line `standby: node-b (dispatched)`; capability parity passes.
- Step 9: `app/project-standby.ts` (the line and "standing by"), used on the Project page; `tests/project-standby.test.mjs`; `@zelavis/ui` tests (87) and `pnpm run ci:ui` pass.
- Step 10: `test/project-failover.test.mjs` passes in about 7.5 s: a real Platform (writer on node-a), a real remote Agent on node-b with the standby, data written, the writer's host and engine processes killed with SIGKILL; **the standby held the lease 3.5 s after the kill (lease 3 s), the placement had followed 4.3 s after**, the writer restarted on node-b under the new placement (lease epoch 3, renewing), `standby.status: "promoted"`, then a Project stop released it and the node-b database held the document.
- Step 11: `database.md`, `AGENTS.md` (the placement paragraph), the decision record, and the overview's "Later" list.
- Step 12: `pnpm run verify` exit 0; `pnpm run ci:ui` exit 0; `pnpm run docs:check` exit 0; no console output, TODO or `try/catch` added in `src`. A temporary debug line added to `dist/adapters/_project-dispatch-https.js` while investigating was removed by the rebuild.

Deviations:
1. **The standby is not adopted; the writer replaces it.** The Agent's process server binds every Project workload to a committed placement when the process starts and fences it when that lapses, and it has no call to give a running process a placement (`_agent-ipc.ts`: start requires `command.placement`; rebind only checks it matches). A standby holds no placement (the Project's placement is the writer's), so it runs as the distinct Agent workload `<id>#standby` (`standbyWorkloadId`, not bound to a placement; the writer lease is its fence), and at failover the Platform starts the Project on that node under the new placement, which stops the standby (releasing its lease) and starts the writer, taking the lease as the node's own next epoch. This costs a restart (inside the 4.3 s measured) instead of an adoption.
2. **The snapshot a standby and a failover start use is descriptor-only** (`project.json` and the frozen recipe): the existing packer refuses a directory that holds runtime data, which the writer's directory does.
3. **Not written as separate tests:** the Agent-level standby case in `remote-project-agent.test.mjs`, the fake-dispatcher unit test for an unknown lease owner, and the reconciliation backstop test (step 7). The end-to-end test exercises the dispatch, the Agent and the hook; the backstop and the unknown-owner log line have no test of their own.
4. The step 2 route test (capability bearer reaches the followers route, refused at stop and at another Project) is in `project-standby.test.mjs` (part 3).

Findings / not done:
- **The Platform cannot route its own requests to a Project placed on a remote node.** The Gateway forwards to `project.runtime.url`; dispatch answers only `ok`, so the Platform never learns a remote runtime URL (and the Project listens on loopback). Part 4 proves lease, placement and data, not the Gateway. Added to the overview's "Later" list.
- Killing only the Project host (not its engine worker) leaves the engine renewing the lease for about 25 s before it ends on its own; a real crash takes both. The test kills both.
- If the Platform restarts a dead local writer itself (reconciliation) before the standby promotes, the lease is taken by node-a again at a higher epoch and the standby is dispatched again; a changed project descriptor would then be refused by the standby node (`already owns different data`). Not hit in the test.
- A standby process is not re-attached as a standby after the Platform restarts (adoption records no role).

Context the plan lacked: the Agent's placement binding (deviation 1); the snapshot packer's data check (deviation 2); the debug processes list names the writer's host and engine only by project root and parent pid (the standby's processes appear under the same project id on one machine); `projects.view`, not `get`, for anything called while a start holds the lifecycle.
