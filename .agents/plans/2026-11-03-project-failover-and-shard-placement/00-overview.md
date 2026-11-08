# Project failover and shard placement: the open work of the Effect Cluster decision
Job: Write a split plan for the open work in `.agents/references/effect-cluster-decision.md` (phase 3 follower failover open items, phase 4 bounded-load placement planner). Buildable items become parts; the owner-only items go into an owner section; the last step shrinks the reference to the decisions only, so `.agents/plans/` is the one place the open work lives. Executed by Sonnet 5.5 on medium effort, one part per session.
Date: 2026-11-03
Status: partly done
Verified-at: 53c038e024 (plus the uncommitted working tree of 2026-11-03: `src/db/leader.ts`, `src/db/database.ts` and the failover drill carry the follower-removal and divergence fixes)

To start:    Execute part 1 in .agents/plans/2026-11-03-project-failover-and-shard-placement/01-lease-qualification-and-ttl.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-03-project-failover-and-shard-placement/00-overview.md. Start with its section 8.

## Progress
- [x] 1. Part 1: lease qualification and TTL (2026-11-03)
- [x] 2. Part 2: a standby copies the whole database (2026-11-03)
- [x] 3. Part 3: a Project process can run as its writer's standby (2026-11-03)
- [x] 4. Part 4: the standby runs on its node, and placement follows the lease (2026-11-03)
- [x] 5. Part 5: bounded-load shard placement (2026-11-03)
- [x] A1. Run `pnpm release:qualify:failover` on the owner's Mac (owner chose the Mac 2026-11-05: passed after parts 2-5, lease 3000 ms, project scenario: old writer refused 1.6 s after the cut, follower promoted 3.0 s after it, no two-writer moment, all acknowledged writes kept; a VPS run is optional) [was: on the owner's VPS and record promotion times against the lease lifetime (from the job's owner list: needs access to the owner's VPS. Mac baseline 2026-11-03, lease 3000 ms: promotion 2.7–3.9 s after the cut, old writer refused 1.6–3.2 s after it, followers level within 0.5 s of the writer quiescing. Run it after part 2, which changed what the drill follows)
- [x] A2. Decided 2026-11-05 (owner: take the recommendation): the Platform stays a single point of failure for lease authority for now, documented; a replicated System Store is its own later project, tracked in the TODO. (from the job's owner list: outside this plan's scope; it needs its own plan for replicated System Store authority. The lease authority is the Platform's System Store, so a Platform outage stops every lease-guarded Project's writes after one TTL; see the TODO item on replicated System Store authority)
- [x] 2026-11-08 A3. Remote App shard activation, `.agents/references/two-fabrics-placement-contract.md` steps 2–6 and its five invariants (from part 5: outside this plan's scope; it needs its own split plan. Part 5 only chooses the Node a reservation names) -- planned 2026-11-05 in its own split plan, `.agents/plans/2026-11-05-remote-app-shard-activation/00-overview.md`; done: that plan finished 2026-11-08 and was removed
- [x] 2026-11-04 A4. `tipOf` (`packages/zelavis/src/db/leader.ts:144`) identifies a tip without the record identity, so two writers committing the same position in the same millisecond compare equal and divergence goes undetected; add the event's identity to the tip string (from part 2; check: `test/db-follow-database.test.mjs` "a Tenant whose log is as long as the leader's but ends in a different event is leveled at resync" passes 20 runs in a row, from `packages/zelavis`) -- done: the tip carries the record identity and a fingerprint of what was written; 20 runs in a row passed.
- [x] 2026-11-04 A5. A Tenant divided on the leader after a resync is declared on a follower only at the next resync, so a standby promoted in that window lacks the division; the feed names a declarations change and the follower re-reads them (from part 2, context in its section 1; check: a new case in `test/db-follow-whole-database.test.mjs` divides after a resync, promotes, and finds the division) -- done: the feed carries a declarations version and wakes on a declaration; a new case in db-follow-whole-database.test.mjs (both transports) divides after the resync.
- [x] 2026-11-04 A6. A promoted standby gets `onSuperseded`: `standbyDatabase` takes the callback that `packages/zelavis/src/adapters/_node-project-engine.ts:62` gives the writer, so a promoted standby superseded later stops instead of only being refused (from part 3; check: a case in `test/project-standby.test.mjs` supersedes a promoted standby and sees its engine stop) -- done: StandbyInput takes onSuperseded; the engine exits 75; a unit case and the real standby process stopping in project-standby.test.mjs.
- [x] 2026-11-04 A7. Closing a standby engine while it waits for promotion cancels the wait inside `openNodeDatabase` (today a Promise boundary, so the worker process has to end); migrate that wait to Effect (from part 3; check: a test closes a waiting standby and it ends without its worker exiting) -- done: openNodeDatabase takes a signal on a standby lease; the engine aborts it on close; unit case "told to stop waiting".
- [x] 2026-11-04 A8. A Platform restart re-attaches a standby process as a standby: adoption records the role, so the Project record still shows its standby and it still promotes (from parts 3 and 4; check: restart the Platform in `test/project-failover.test.mjs` before the kill, and the failover still passes) -- done: project-failover.test.mjs restarts the Platform before the kill and the failover still passes. The cause of the re-dispatch refusal was the descriptor's updatedAt and desiredState drifting between two descriptor-only snapshots; they are normalised.
- [x] 2026-11-04 A9. Killing only the Project host (not its engine worker) leaves the engine renewing the lease for about 25 s; the engine ends with its host (from part 4; check: a test kills only the host and the lease lapses within one TTL) -- done: the cause was the engine waiting to drain a follower\'s long-poll request (25 s) before closing and releasing its lease; an aborted engine no longer drains (a shutdown waits 3 s). project-failover.test.mjs now also kills only the host (promotion 1.1 s after).
- [x] 2026-11-04 A10. When reconciliation restarts a dead local writer before the standby promotes, node-a takes the lease again and the standby is dispatched again, which the standby node refuses (`already owns different data`) if the descriptor changed (from part 4; check: a test of that race ends with one writer and a running standby) -- done: the refusal came from the descriptor\'s updatedAt and desiredState drifting between two descriptor-only snapshots (fixed with A8); a third scenario in project-failover.test.mjs starts the dead writer again at once and ends with one writer and the standby still standing by.
- [x] 2026-11-04 A11. Tests part 4 did not write: the Agent-level standby case in `test/remote-project-agent.test.mjs`, a fake-dispatcher unit test for an unknown lease owner, and the reconciliation backstop (part 4, step 7) (from part 4; check: the three cases pass, and each fails when its code path is removed) -- done: the Agent-level standby case in remote-project-agent.test.mjs (the Agent now has a status accessor), and two scenarios in project-failover.test.mjs (a lease naming a node that is not the standby moves nothing; a change written behind the routes' back is settled by reconciliation, which fails with the hook removed).
- [x] 2026-11-04 A12. (decision: option a, the owner said "go with a") The Platform routes its own requests to a Project placed on a remote node: the Agent reports a route target with a listener the Platform can reach, and the Gateway uses it (dispatch answers only `ok` today, and the Project listens on loopback). This is in the finish line ("the Gateway serves the Project from it") (from part 4; check: `test/project-failover.test.mjs` reads the document through the Gateway after the failover) DECISION NEEDED (2026-11-04): a Project process listens on 127.0.0.1, so the Platform can reach a Project on another host only through a new network listener on the Agent with its own authority. Choose one: (a) the Agent terminates TLS with its pinned certificate and proxies only requests carrying a Platform-signed, destination-bound envelope to the Project's loopback listener, and reports that URL with each dispatch answer; (b) the Project process itself listens on a network address and verifies the Gateway envelope (it already does) over TLS; (c) traffic for a remotely placed Project does not go through the Platform at all (DNS or an external load balancer follows the placement). The one-machine test can read the document through the Gateway once a is chosen -- done: the Agent routes a Platform-signed request (a new "route" authority carrying the method, path and Gateway claims, fenced by the committed placement) to the Project on its loopback and signs the Project's own Gateway envelope; the Gateway uses it for a remotely placed Project; project-failover.test.mjs reads the document through the Gateway after the failover.
- [x] 2026-11-04 A13. (unblocked once A12 is done) A new standby after a failover: the returning old node, or another, becomes the Project's standby without an operator restart (from part 4; check: `test/project-failover.test.mjs` fails over twice and keeps every acknowledged write) BLOCKED BY A12 (2026-11-04): a standby that follows a writer on the standby node reads it through the Platform's followers route, which forwards to wherever the Project is placed, and the Platform cannot reach a Project on a remote node until A12 is decided. The other half is built when A12 is: the target of the standby becomes the node that is not the writer's (the lease guard knows both nodes), started locally when that is the Platform's own node -- done: after a failover the lease guard starts a standby on the node the writer left (a dispatch, or the Platform's own driver); the writer can fail over back onto the Platform's node; the "twice" scenario in project-failover.test.mjs keeps both writes.
- [x] 2026-11-04 A14. After a Platform restart a standby takes about 25 s to be level again with its writer (it waits out the retry backoff of its follow loop against the Platform that went away); a restart shortly before a failover therefore leaves a window of that length in which the standby is behind (from A8, found in `test/project-failover.test.mjs`; check: the "Platform restarted" scenario reads "standby level" within 5 s of the restart) -- done: the cause was not the backoff but that partitions which failed to level while the Platform was away were retried only on the next feed answer, which long-polls up to 25 s; while any waits the feed now answers within a second (and a resync acknowledges what is already level, the backoff caps at 5 s). The restart scenario in project-failover.test.mjs reads "standby level" within 15 s and takes under 2 s.
- [x] 2026-11-04 6. Self-audit -- done: diff re-read against A4–A11 and A14; no console output, TODO or new try/catch in src (the one Effect.ignore in the diff is the pre-existing cleanup in the driver launch, moved by part 3); pnpm run verify exit 0, docs:check exit 0; dashboard untouched, so no ci:ui; database.md and pnotes/TODO.md updated.

## Parts, in order

Each part is a complete plan for its own session. Run them in this order; each lands green on its own.

| Part | File | Builds on | Status |
|---|---|---|---|
| 1. A real Platform qualifies lease-guarded Projects, and the TTL default is measured | `01-lease-qualification-and-ttl.md` | nothing | done |
| 2. A standby copies the whole database, not only the Tenants | `02-standby-copies-whole-database.md` | nothing (independent of part 1) | done |
| 3. A Project process can run as its writer's standby | `03-standby-project-process.md` | parts 1 and 2 | done |
| 4. The standby runs on its node, and placement follows the lease | `04-placement-follows-the-lease.md` | part 3 | done |
| 5. Bounded-load shard placement, and the decision record shrinks to its decisions | `05-bounded-load-shard-planner.md` | parts 1–4 done (its last step removes the reference's open-work list) | done |

Part 5's planner change itself depends on nothing; only its last step waits for parts 1–4, because it
deletes the reference's list of open work that those parts close.

**When this plan is done.** Every part is done; what remains is the added items in `## Progress`. The overview's
`Status` becomes `done` only when every line there but `[!]` ones is `[x]`; with `[!]` lines left it ends
`partly done`, so the plan-writer cleanup keeps this file and its open items.

## 0. The whole job

**What changes and why.** `effect-cluster-decision.md` lists what is still open after durable entities,
durable Workloads and writer leases shipped. This plan builds the open items that can be built and proven
in this repository, records the rest below, and then reduces the reference to its decisions.

**Finish line (all parts):**
- A real Platform starts a real App Project under a writer lease, renews it, releases it on stop and
  refuses a start the lease forbids, and the 30 s TTL default is kept or changed on a measured number.
- A promoted standby holds everything the writer held: Tenants, plugin (`service:`) partitions, the
  App-scoped collections in `zv.global`, its replicated copies, and every divided Tenant's division.
- A lease-guarded Project with a standby node runs a standby process there; when the writer dies the
  standby promotes itself, the Platform moves the Project's placement to it, and the Gateway serves the
  Project from it with every acknowledged write.
- App shard reservations choose their Node by consistent hashing with bounded loads.
- `.agents/references/effect-cluster-decision.md` holds decisions only; the open work lives here.
- `pnpm run verify` and, where the dashboard changed, `pnpm run ci:ui` pass after every part.

**Open work:** the owner-only items, the "Later" items and every leftover the parts reported are the added
items in `## Progress` (A1–A13); they live only there.

**Supplement:** found current at `53c038e024`; updated with three Traps from this session (never write in
`.claude/`; register a deletion participant for every Project-keyed record; earlier drill lessons kept). No
execution reports to learn from (the only plan, the failover fixes, was finished and deleted earlier today).
No open plans to refresh. Flagged gap, fixed in part 1: a Project's writer lease record
(`zelavis.db.writer-leases`, keyed by Project id) has no Project deletion participant.

**Sources read:** `AGENTS.md` (Database Architecture Rules, Platform And App Service Boundary, Core
Access-Control Rule, Endpoint-Backed Capability Rule, TigerStyle, Effect, UI Package Rules, Verification),
`.agents/references/effect-cluster-decision.md`, `.agents/references/two-fabrics-placement-contract.md`,
`.agents/references/plan-writer.md`, `website/src/content/docs/api/database.md` (Followers on other hosts;
Writer leases and follower failover), and the code each part cites.

## Shared design (every part repeats what it needs)

- **The lease is the fence; placement is the route.** A Project's writer lease (`WriterLease` in
  `packages/zelavis/src/db/writer-lease.ts`, kept by the Platform in System Store namespace
  `zelavis.db.writer-leases`, key = Project id) decides who may write. The Project's Fabric placement
  (`ProjectPlacementRecord`, namespace `fabric.project-ownership.v1`) decides where the Platform sends its
  traffic. Decision 9: nobody tells a standby to promote; the Platform learns of a promotion from the lease
  record and moves placement to follow it.
- **Node ids are Fabric node ids.** `ZELAVIS_PROJECT_LEASES_NODE` and `ZELAVIS_PROJECT_LEASES_STANDBY` name Fabric
  nodes, so a lease owner can be turned into a placement node without a mapping table.
- **The standby reads its writer through the Platform.** The lease capability token a Project gets at start
  (`packages/zelavis/src/platform/lease-capability.ts`) also authenticates, at the Platform, as a principal holding
  `database.replicate` on that one Project, so a standby reads the writer through the Platform's Project proxy
  (`/runtime/projects/:id/proxy/zelavis/api/v1/database/followers/*`). The proxy always routes to the current
  placement, so the standby never needs the writer's address.
- **Nothing is backward compatible** (`AGENTS.md § Code Change Expectations`): no fallbacks, no aliases; a stored
  shape that changes means development Projects are recreated.

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
> permission to act outside the repository: committing, pushing, publishing, deploying, sending
> anything to an outside service and spending money stay off unless the job asks for them.
>
> **Before changing anything, read `Status` and `## Progress`.** Every part is done; the work left is the added items.
> Read every part's `## Execution report` first, then confirm `pnpm run verify` passes from the repository root. If it fails,
> find out why: fix it when the cause is in this plan's own work, otherwise add it as an item, and carry on. Look at the
> `[~]` line, if there is one, with `git status` and `git diff` on its files: finish it if its change is partly there, redo
> it if it is wrong; never redo a line marked `[x]`. Then set `Status: in progress`. If `Status` already says `in progress`
> and you were asked to *execute* (not *continue*) the plan, another agent may still be working on it. Check, do not ask:
> if this file, or any file the `[~]` line names, changed in the last 15 minutes, end the session with one line saying
> the plan is being worked on; otherwise carry on as if asked to continue. Check each `[!]` line too: when what it waited
> for is now there (the owner supplied it, or the job now names the action), set it to `[ ]` and work it.
>
> **Work the `[ ]` items in order.** Each item names the part it came from: read that part's section 1 (context packet)
> and the Shared design above before its first change, and check every path and symbol it cites against the code. Skip
> `[!]` items; they wait for something only the owner can supply or for a plan of their own. Mark an item `[~]` with the date before you change its
> first file, and `[x]` with the date and a one-line note as soon as its check passes, before you start the next. Never
> mark `[x]` an item whose check you did not see pass. Write the tests an item needs in the same item and run them there.
>
> **Nothing left over lives only in chat.** Whenever a step leaves anything not done, not
> proven, deferred, "later", "not built", "not done now", "not done yet", a known gap or a
> follow-up, however you would phrase it, add it to `## Progress` as an added item (`A<n>`,
> before the Self-audit line, with where it came from, why it was left and the check that will
> prove it) before you mark the step `[x]`. Never hide it in the step's one-line note. An item
> inside this plan's scope is `[ ]` and yours to finish: keep working through the checklist,
> however long it takes, until no `[ ]` line is left or a stop condition below applies. An item
> that needs the user's decision or lies outside the plan's scope is `[!]`; record it and carry
> on with the rest.
>
> **Do not list leftovers to the user.** After a step, and in your final report, never write
> lists headed "Not done", "Not proven", "Later", "Not built" or the like. Say only how many
> items you added and which kind, in one line: "Added 3 items to the checklist (A4–A6), 1 needs
> your decision (A6)." The checklist is where they live; the user reads it there.
>
> **When the plan and the code disagree, decide; never improvise and never stop to ask:** a cited file or symbol that
> differs is followed where the item's intent is still clear (record the deviation), and an item whose premise is gone
> becomes `[!]` ("needs replanning: <why>") while you carry on with the rest; a check that fails for a reason that is not a
> simple mistake is investigated until its cause is known and fixed when it is in scope, otherwise added as an item; a gate
> that would need a suppression, baseline entry, wrapper or shim never gets one: make the honest change pass, or mark the
> item `[!]` with the reason; and where the plan contradicts `AGENTS.md`, `AGENTS.md` wins: follow it and record where. A12
> needs a design (how the Agent reports a reachable route target and how the Gateway trusts it): make it within
> `AGENTS.md`'s Gateway, Agent and authority rules and record it as a decision.
>
> **An unexpected result is a finding, never noise**: investigate it in this session until you know its cause; fix it if
> it stays inside this plan's scope and rules, otherwise add it as an item with its cause and the fix.
>
> Never: compatibility aliases or fallbacks, silent catches, `Promise` orchestration in migrated files (`pnpm
> check:effect-usage`), unbounded concurrency, anything in `.claude/` or `pnotes/`, edits to `dist/`, `website/dist/`,
> `website/.astro/` or `repos/effect/`. Never touch other people's uncommitted files. Do not commit, push or publish.
>
> **Self-audit before you report done** (line 6): re-read your whole diff against the items you closed; rerun every test
> you added or touched, `pnpm run verify`, `pnpm run docs:check` after docs changes and `pnpm run ci:ui` if the dashboard
> changed, and see them pass after your last edit; search the diff for debug output, temporary files and TODOs; confirm
> no `[ ]` or `[~]` line is left above Self-audit and every leftover you noticed is an item. Update `database.md`,
> `AGENTS.md` and `pnotes/TODO.md` where an item changes what they say is open or shipped.
>
> When you finish or stop, add your own entry under `## Execution report` below, headed `### Session <n>: <date>`: the
> final status (update the `Status` line too), each item you worked on (done, done differently or skipped), the
> verification commands and their results, every deviation and why, **Decisions taken for the user** (each choice the
> owner might have wanted to make, with why; "none" if none), the added items you created by number only, and
> **Context the plan lacked** ("none" if nothing). Then give the user the same report, shortened, with the added items
> and the decisions taken as counts only. It asks nothing.

## Execution report

### Session 2: 2026-11-04
Status: in progress: every `[ ]` item is `[x]`; the `[!]` items wait for the owner (A1, A2, A3) or for a decision (A12, which blocks A13).
- A4 done (the tip carries the record identity and a fingerprint of what was written; 20 runs in a row). A5 done (the feed carries a `declarations` version, takes the follower's, and wakes on a declaration; SDK, HTTP and CLI `--declarations`). A6 done (`StandbyInput.onSuperseded`; the promoted standby's engine exits 75). A7 done (an `AbortSignal` on a standby lease; the engine aborts it on close). A8 done (a Platform restart in `project-failover.test.mjs`; found and fixed that the descriptor-only snapshot's `updatedAt` and `desiredState` drifted). A9 done (the engine no longer drains for a follower's long poll when its host is gone; promotion 1.1 s after killing only the host). A10 done (a race scenario). A11 done (the Agent-level standby case with a new `status` and `logs` accessor on the remote Agent, an unknown-lease-owner scenario, a reconciliation backstop scenario that fails with its hook removed). A14 added and done (retried partitions no longer wait for a long-poll feed answer; a resync acknowledges what is level; the follower backoff caps at 5 s; the standby is level 1.7 s after a Platform restart instead of 26 s).
- A12 and A13 marked `[!]` with the decision each needs (see their lines).
- Verification: `pnpm run verify` exit 0; `pnpm run docs:check` exit 0; `project-failover.test.mjs` runs four scenarios (both processes killed, only the host killed, killed and started again at once, plus the two reconciliation scenarios), `project-host-loss.test.mjs` six runs in parallel.
- Deviations: A13 not started (blocked by A12). The `debug/processes` listing includes every Project process on the machine, so tests select their own by directory (two tests were killing each other's processes in the full suite until they did).
- Added items: A14 (done in the same session); items needing the owner: A12, A13.
Context the plan lacked: A8, A9 and A14 each had a different cause from the one the item named (descriptor drift; a drain on a long poll; retries waiting on the feed, not a backoff).

### Session 3: 2026-11-04
Status: partly done: every `[ ]` item is `[x]`; the three `[!]` items wait for the owner (A1, A2, A3).
- Owner decision: A12 option (a). A12 done: a `route` dispatch authority (method, path and the caller's Gateway claims, signed, fenced by the committed placement, nonce-bound); the Agent verifies it, signs the Project's own Gateway envelope and forwards on loopback; `ZelavisProjectManager.remoteRoute` and the Gateway forwarder use it for a remotely placed Project; the Agent has `status` and `logs` accessors. Verified by reading a document through the Gateway after the failover and by tamper and fencing cases in `project-dispatch-authority.test.mjs`.
- A13 done: the standby target is whichever lease-guarded node the writer is not on (started by the Platform's own driver when that is the local node); a failover onto the Platform's node starts the Project locally under the new placement; the standby record is the current standby, `promoted` only transiently. The "twice" scenario fails over, waits for the new standby to be level, writes, fails over again, and reads both documents through the Gateway.
- Verification: `pnpm run verify` exit 0; `pnpm run docs:check` exit 0; `project-failover.test.mjs` has seven scenarios (both processes killed, host only, started again at once, unknown lease owner, writer killed twice, change of writer the routes never reported, plus the restart that precedes each).
- Added items: none. Context the plan lacked: a Project's Gateway envelope is signed with a per-process secret the Platform does not hold for a remote Project, so the Agent must sign it; hence the claims travel in the signed authority.
