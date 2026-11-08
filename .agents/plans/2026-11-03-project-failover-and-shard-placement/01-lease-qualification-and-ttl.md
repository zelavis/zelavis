# A real Platform qualifies lease-guarded Projects, and the TTL default is measured
Job: Part 1 of the plan for the open failover and placement work (see 00-overview.md): qualify lease-guarded Projects on a real Platform and decide the TTL default against Platform load.
Date: 2026-11-03
Status: done
Verified-at: 53c038e024 (plus the uncommitted working tree of 2026-11-03)
Part: 1 of 5. Read 00-overview.md first.

To start:    Execute part 1 in .agents/plans/2026-11-03-project-failover-and-shard-placement/01-lease-qualification-and-ttl.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-03-project-failover-and-shard-placement/01-lease-qualification-and-ttl.md. Start with its section 8.

## Progress
- [x] 2026-11-03 1. A Project's lease environment always carries its TTL
- [x] 2026-11-03 2. Deleting a Project deletes its writer lease record
- [x] 2026-11-03 3. A real Platform runs a real App Project under its lease
- [x] 2026-11-03 4. Measure what a lease renewal costs the Platform, and decide the TTL
- [x] 2026-11-03 5. Docs and the decision record
- [x] 2026-11-03 6. Self-audit

## 0. Summary and finish line

Each piece of a lease-guarded Project start is tested alone (the lease capability, the environment the
driver passes, `startWriter`), but nothing has run a real Platform starting a real App Project with
`ZELAVIS_PROJECT_LEASES_*` set. This part adds that test, removes a duplicate TTL default the Project side
keeps, gives the lease record the Project deletion participant it lacks, and measures what a renewal costs
the Platform so the 30 s default is a measured decision.

**In scope:** `leaseFromEnvironment` TTL; a deletion participant for the lease record; one real-Platform test;
one renewal-cost measurement test; docs.
**Out of scope:** standby Projects (parts 3 and 4); any change to the lease protocol itself.

**Done means:**
- `leaseFromEnvironment` refuses a lease environment without `ZELAVIS_LEASE_TTL_MILLIS`; no 15 s fallback remains.
- Deleting a Project removes its record in System Store namespace `zelavis.db.writer-leases`.
- `test/project-lease-platform.test.mjs` passes: a real Platform starts a real App Project that takes, renews
  and releases its lease, takes epoch 2 on restart, and fails to start while another node holds a live lease.
- `test/project-lease-load.test.mjs` passes and prints the measured cost of one renewal; the TTL decision and
  the number are in `website/src/content/docs/api/database.md`.
- `pnpm run verify` passes.

**Supplement:** see 00-overview.md (found current, three Traps added).

## 1. Context packet

**Glossary**
- *Writer lease*: `WriterLease` (`src/db/writer-lease.ts:32`): `{ partition, owner, epoch, expiresAt, acknowledgedHead, endpoint?, standby? }`. For a Project the `partition` is the Project id (the "scope").
- *Lease authority*: the Platform's routes over its System Store: `/runtime/writer-leases/:partition`
  (operators, `database.replicate`) and `/runtime/project-leases/:scope` (a Project process, authorized by its
  lease capability).
- *Lease capability*: an HMAC token naming `(scope, node)` (`src/platform/lease-capability.ts:48`), minted by the
  Platform when it starts a Project, sent as `Authorization: Bearer`.
- *Lease-guarded Project*: one the Platform starts with `ZELAVIS_LEASE_*` in its environment because the operator set
  `ZELAVIS_PROJECT_LEASES_URL`, `_NODE` and `_STANDBY` on the Platform.

**Governing rules**
- "Project runtime placement is a Platform System Store `{owner, epoch}` CAS record … Not yet proven: multi-host
  network-partition drills" (`AGENTS.md § Platform And App Service Boundary`).
- "Any new Platform resource keyed by Project identity must register a cleanup participant"
  (`AGENTS.md § Platform And App Service Boundary`).
- "No backward compatibility … do not add shims, fallbacks" (`AGENTS.md § Code Change Expectations`).
- "Scalability is rule one for the database and the Fabric … a Project's failover lease is one record whatever its
  size" (`AGENTS.md § Database Architecture Rules`).

**System today**
- `src/adapters/_project-lease-environment.ts:29-41` `projectLeaseConfiguration`: reads the Platform's
  `ZELAVIS_PROJECT_LEASES_*`; TTL default 30000, minimum 1000. Lines 44-56 `projectLeaseEnvironment` mints the
  capability and returns the Project's environment, always including `ZELAVIS_LEASE_TTL_MILLIS`.
- `src/adapters/_node-project-engine.ts:21-42` `leaseFromEnvironment`: the Project side. Line 30:
  ```ts
  const ttl = Number(environment.ZELAVIS_LEASE_TTL_MILLIS ?? 15_000);
  ```
  A second default, different from the Platform's, for a value the Platform always sends.
- `src/adapters/node.ts:266` reads `projectLeaseConfiguration()` when the Platform adapter resolves (so the
  environment must be set before the first request); `node.ts:429-431` passes `leaseEnvironment` to the driver.
- `src/adapters/_node-project-runtime.ts:764,785`: the driver mints the environment at each start and puts it in
  the Project process's `env`.
- `src/db/node-host.ts:141-151` `openNodeDatabase`: with a lease, `database.writerLeases.startDatabase(lease)` runs
  before anything is handed out; failure closes the scope, so the Project process fails to start.
- `src/db/writer-lease.ts:432-453` `startWriter`: no lease or this node's own → `acquireWriter` (epoch + 1);
  another node's → `promoteFollower`, which fails with `LeaseStillHeld` while that lease is live.
- `src/db/writer-lease.ts:266-308` `holdWriter`: renews every `ttl / 3`; closing the scope releases (sets
  `expiresAt: 0`, `releaseWriter` at `:178-184`).
- `src/platform/writer-lease-routes.ts:30-155` `createWriterLeaseRoutes`; mounted in `src/index.ts:4648-4652` with
  the capability options `{ secret, projectExists }`.
- `src/platform/writer-lease-store.ts:15` `NAMESPACE = "zelavis.db.writer-leases"`, `:20` `systemStoreLeaseStore`;
  audit namespace `fabric.writer-lease-audit.v1` (`:64`), newest 500 kept.
- Project deletion participants: `src/index.ts:7264-7279` (`project-placement-authority`, `app-data-placement`).
  The lease record has none.

**Pattern to mirror**
- Deletion participant: `src/platform/project-placement-authority.ts:214-222`:
  ```ts
  export function deleteProjectPlacementAuthority(
    store: ZelavisSystemStore,
    projectId: string,
  ): Promise<void> {
      return present(Effect.gen(function* (): Effect.fn.Return<void, IntegrationFailure> {
    if (!validId(projectId)) throw new TypeError("Invalid Project id for placement cleanup");
    (yield* integrationValue(store.delete(NAMESPACE, projectId)));
  }));
    }
  ```
- A real Platform with a real App Project: `test/remote-project-agent.test.mjs:18-50` (creates `new Zelavis({ adapter:
  nodeAdapter({ dataDirectory }) })` and `POST /runtime/projects` as `OWNER`).
- Serving routes over node:http: `distribution/scripts/failover/authority.mjs` (reads the body, builds params,
  calls the route handler). For this part serve the whole Platform instead: `zv.fetch(new Request(...))`.

**Traps**
- Setting `process.env.ZELAVIS_PROJECT_LEASES_*` after the Platform resolved: it is read once at resolve. Set it
  before `new Zelavis(...)` and restore it in `finally`.
- A fixed sleep before asserting a renewal: poll for `expiresAt` to grow, with a deadline (see `until` in
  `test/project-lease-start.test.mjs:9-12`).
- Asserting through anything but the public routes: read leases with `GET /runtime/writer-leases/:id` as `OWNER`.
- Deleting the audit entries with the Project: the audit is the Platform's history, bounded at 500; only the lease
  record is the Project's resource.

## 2. Design

- **Authority and scope.** Unchanged: the Platform's System Store holds the lease; a Project process writes only its
  own lease, as its own node (capability). Operators read through `database.replicate` (system scope).
- **Persistence.** Unchanged shape. Deletion removes the one record `zelavis.db.writer-leases/<projectId>`.
- **Invariants.** (1) A Project process never invents a TTL: it uses the Platform's (`leaseFromEnvironment`).
  (2) No lease record outlives its Project (deletion participant).
- **Failure model.** A lease environment without `ZELAVIS_LEASE_TTL_MILLIS` throws at start ("A lease-guarded
  Project start needs ZELAVIS_LEASE_TTL_MILLIS …"), so the Project fails to start with that message in its logs.
- **Decisions.**
  - *Require the TTL instead of defaulting it.* The Platform always sends it (`_project-lease-environment.ts:53`);
    a second default could only ever disagree with the first. Rejected: keeping 15 s "as a safety net" (a fallback).
  - *Measure the route and store, not HTTP.* The renewal cost the Platform pays is the route handler plus one
    System Store read and compare-and-set; HTTP framing is the same for every route. Rejected: a load test over
    sockets (slow, noisy, measures the test machine's network stack).
  - *The TTL rule.* Keep 30 000 ms if one renewal costs at most 1 ms of Platform time: 1 000 running Projects then
    renew 100 times a second, at most 10 % of one core. If it costs more, stop and report the number; the TTL is
    then an owner decision (longer failover against Platform load).
- **Open questions:** none.

## 3. Contracts

- `leaseFromEnvironment(projectId, environment)` (`src/adapters/_node-project-engine.ts`): unchanged signature;
  throws when `ZELAVIS_LEASE_TTL_MILLIS` is missing or not an integer ≥ 1000.
- **NEW** `deleteProjectWriterLease(store: ZelavisSystemStore, projectId: string): Promise<void>` in
  `src/platform/writer-lease-store.ts`.
- No route, SDK or CLI changes.

## 4. Execution steps

### Step 1. A Project's lease environment always carries its TTL
- **Files:** `packages/zelavis/src/adapters/_node-project-engine.ts`, `packages/zelavis/test/project-lease-start.test.mjs`.
- **Context:** line 30 defaults the TTL to 15 000 although `projectLeaseEnvironment` always sends it.
- **Change:** in `leaseFromEnvironment`, after the token/owner/standby check:
  ```ts
  const ttl = Number(environment.ZELAVIS_LEASE_TTL_MILLIS);
  if (!Number.isSafeInteger(ttl) || ttl < 1000) {
    throw new Error("A lease-guarded Project start needs ZELAVIS_LEASE_TTL_MILLIS, an integer of at least 1000, beside ZELAVIS_LEASE_AUTHORITY.");
  }
  ```
  and use `ttlMillis: ttl`. In the test `"the lease is configured from the environment, all or nothing"` (`:35`), add:
  `assert.throws(() => leaseFromEnvironment("p1", { ZELAVIS_LEASE_AUTHORITY: "http://platform/api", ZELAVIS_LEASE_TOKEN: "t", ZELAVIS_LEASE_NODE: "node-a", ZELAVIS_LEASE_STANDBY: "node-b" }), /ZELAVIS_LEASE_TTL_MILLIS/);`
- **Depends on:** nothing.
- **Check:** `cd packages/zelavis && pnpm --filter zelavis run build >/dev/null; node --test test/project-lease-start.test.mjs test/project-lease-capability.test.mjs; echo "exit $?"` → `exit 0` (the capability test's driver case passes no TTL only through `projectLeaseEnvironment`, which includes it; if `project-lease-capability.test.mjs:110` builds an environment by hand without the TTL, add `ZELAVIS_LEASE_TTL_MILLIS: "30000"` to that object).

### Step 2. Deleting a Project deletes its writer lease record
- **Files:** `packages/zelavis/src/platform/writer-lease-store.ts`, `packages/zelavis/src/index.ts`, `packages/zelavis/test/project-lease-capability.test.mjs`.
- **Context:** `AGENTS.md`: every Project-keyed Platform resource registers a cleanup participant. The lease record is
  keyed by the Project id in `zelavis.db.writer-leases` and has none.
- **Change:** add to `writer-lease-store.ts` (imports: `present`, `integrationValue`, `type IntegrationFailure` from
  `../core/runtime/effect-boundary.js`; add those not already imported there):
  ```ts
  /** Project deletion participant: the Project's own lease record. The audit trail is the Platform's history and stays. */
  export function deleteProjectWriterLease(store: ZelavisSystemStore, projectId: string): Promise<void> {
    return present(Effect.gen(function* (): Effect.fn.Return<void, IntegrationFailure> {
      if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 512) throw new TypeError("Invalid Project id for writer lease cleanup");
      yield* integrationValue(store.delete(NAMESPACE, projectId));
    }));
  }
  ```
  In `src/index.ts`, import it beside `systemStoreLeaseAudit, systemStoreLeaseStore` (`:3`) and add after the
  `app-data-placement` participant (`:7272-7279`):
  ```ts
  {
    id: "project-writer-lease",
    cleanup: (project: Readonly<ZelavisProjectRecord>) => deleteProjectWriterLease(systemStore, project.id),
  },
  ```
  (mirror how the neighbouring participants guard on `systemStore`; if they sit inside a `systemStore ? [...] : []`
  block, put this one in the same block).
- **Test** (in `project-lease-capability.test.mjs`, new case): `deleteProjectWriterLease removes the record and is idempotent` —
  arrange `createMemorySystemStore()`, `systemStoreLeaseStore(store).create({ partition: "p1", owner: "a", epoch: 1, expiresAt: 1, acknowledgedHead: 0 })`;
  act `await deleteProjectWriterLease(store, "p1")` twice; assert `Effect.runPromise(systemStoreLeaseStore(store).read("p1"))` is `undefined`.
- **Depends on:** nothing.
- **Check:** build, then `node --test test/project-lease-capability.test.mjs; echo "exit $?"` from `packages/zelavis` → `exit 0`.

### Step 3. A real Platform runs a real App Project under its lease
- **Files:** **NEW** `packages/zelavis/test/project-lease-platform.test.mjs`.
- **Context:** the pattern in `test/remote-project-agent.test.mjs:18-50`; leases are configured on the Platform only
  (`node.ts:266`); a Project process reaches the authority at `ZELAVIS_PROJECT_LEASES_URL`, so the Platform must
  listen on a real port.
- **Change:** one test, `{ timeout: 120_000 }`:
  1. `const server = createServer(...)` (node:http) on `127.0.0.1:0` that turns each request into
     `new Request(\`http://127.0.0.1:${port}${request.url}\`, { method, headers, body })` (body only for non-GET) and
     answers with `await zv.fetch(webRequest)`; `zv` is assigned after the server listens.
  2. Set `process.env.ZELAVIS_PROJECT_LEASES_URL = \`http://127.0.0.1:${port}/zelavis/api/v1\``,
     `ZELAVIS_PROJECT_LEASES_NODE = "node-a"`, `ZELAVIS_PROJECT_LEASES_STANDBY = "node-b"`,
     `ZELAVIS_PROJECT_LEASES_TTL_MILLIS = "3000"`; restore the previous values in `finally`.
  3. `zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory }) })`; `POST /runtime/projects` with
     `{ id: "leased", name: "Leased", recipeName: "@zelavis/app", start: true }` as `OWNER` (the object at
     `remote-project-agent.test.mjs:16`); poll `GET /runtime/projects/leased` until `runtime.status === "running"`.
  4. Assert `GET /runtime/writer-leases/leased` (as `OWNER`) → `lease.owner === "node-a"`, `lease.epoch === 1`,
     `lease.standby === "node-b"`, `lease.expiresAt > Date.now()`.
  5. Poll (≤ 5 s) until `expiresAt` is greater than in 4: renewal happens.
  6. `GET /runtime/writer-lease-audit` → an entry with `partition: "leased"`, `principal: "project:leased@node-a"`,
     `to: { owner: "node-a", epoch: 1 }`.
  7. `POST /runtime/projects/leased/stop`; assert the lease now has `expiresAt === 0` (released).
  8. `POST /runtime/projects/leased/start`; wait for running; assert `lease.epoch === 2`, owner `node-a`.
  9. Stop it; read the lease and its `version`; `PUT /runtime/writer-leases/leased` as `OWNER` with
     `{ lease: { ...lease, owner: "node-x", epoch: lease.epoch + 1, expiresAt: Date.now() + 60_000 }, expectedVersion: version }`;
     start it again; poll until `runtime.status === "failed"`; assert `GET /runtime/projects/leased/logs` has an
     entry whose message matches `/LeaseStillHeld/`.
  10. `DELETE /runtime/projects/leased`; deletion is a durable operation, so poll (≤ 30 s) until
      `GET /runtime/projects/leased` answers 404, then assert `GET /runtime/writer-leases/leased` answers 404 (step 2).
  Close in `finally`: `zv.close()`, `server.close()`, remove the directory.
- **Imports:** `assert` from `node:assert/strict`, `test` from `node:test`, `createServer` from `node:http`,
  `mkdtemp, rm` from `node:fs/promises`, `tmpdir` from `node:os`, `join` from `node:path`,
  `Zelavis` from `../dist/index.js`, `nodeAdapter` from `../dist/adapters/node.js`.
- **Where values come from:** `principal: "project:leased@node-a"` is written by `writeCore` (`writer-lease-routes.ts:149`,
  `` `project:${claims.scope}@${claims.node}` ``); the 404 in 10 comes from `readCore` (`:36`).
- **Depends on:** steps 1 and 2.
- **Check:** build, then `node --test test/project-lease-platform.test.mjs; echo "exit $?"` from `packages/zelavis` → `exit 0`.
  If 9 shows a different refusal than `LeaseStillHeld`, that is a finding: find why before changing the assertion.

### Step 4. Measure what a lease renewal costs the Platform, and decide the TTL
- **Files:** **NEW** `packages/zelavis/test/project-lease-load.test.mjs`.
- **Change:** arrange a SQLite System Store (`createLocalSqliteSystemStore({ filename })` from
  `../dist/adapters/_sqlite-system-store.js`) and `createWriterLeaseRoutes(systemStoreLeaseStore(store), systemStoreLeaseAudit(store))`;
  find the route with `id === "runtime.writerLeases.write"`; create 200 leases (`PUT` without `expectedVersion`), then
  renew each of them 10 times (read with `runtime.writerLeases.read`, write back with `expiresAt` raised and the
  `version` read), 2 000 renewals in all, timing only the renewals with `performance.now()`. Print
  `console.log(\`renewal: ${(elapsed / 2000).toFixed(3)} ms\`)`. Assert the average is below 5 ms (a guard against
  a regression, not the decision).
- **Decide:** if the printed average is ≤ 1 ms, keep the 30 000 ms default. If it is above 1 ms, stop and report the
  number (the TTL is then the owner's call, see section 2).
- **Depends on:** nothing.
- **Check:** build, then `node --test test/project-lease-load.test.mjs; echo "exit $?"` → `exit 0` and a `renewal: … ms` line.

### Step 5. Docs and the decision record
- **Files:** `website/src/content/docs/api/database.md` (section "Writer leases and follower failover", the
  `ZELAVIS_PROJECT_LEASES_*` paragraph at `:207-209`); `.agents/references/effect-cluster-decision.md`.
- **Change:** in the docs paragraph, say that the Project receives the Platform's TTL and refuses to start without it,
  that a deleted Project's lease record is removed with it, and the measured renewal cost with the conclusion
  ("one renewal costs about N ms of Platform time, so 1 000 running Projects take about M % of one core; the
  default stays 30 s"). In the decision record's phase 3 list, delete the item "Qualify lease-guarded Projects on a
  real Platform …" (it is done; the plan carries the rest).
- **Check:** from the repository root `pnpm run docs:check; echo "exit $?"` → `exit 0`.

### Step 6. Self-audit
See section 8. Check from the repository root: `pnpm run verify; echo "exit $?"` → `exit 0`.

## 5. Tests
- `project-lease-start.test.mjs`: missing TTL refused (step 1).
- `project-lease-capability.test.mjs`: `deleteProjectWriterLease` removes and is idempotent (step 2).
- `project-lease-platform.test.mjs`: take, renew, audit, release on stop, epoch 2 on restart, refusal under another
  node's live lease (failure path), record gone after deletion (step 3).
- `project-lease-load.test.mjs`: renewal cost measured and bounded (step 4).
No dashboard change, so no browser test.

## 6. Docs and project notes
`website/src/content/docs/api/database.md` and the decision record (step 5). No `pnotes/` change.

## 7. Verification
From the repository root: `pnpm run verify; echo "exit $?"` → `exit 0`; `pnpm run docs:check` → `exit 0`.

## 8. Instructions to the implementer

> **Before changing anything, read `Status` and `## Progress`.**
> - First compare `Verified-at` with `HEAD`. If any path the plan cites changed since
>   (`git diff --name-only 53c038e024..HEAD`), check each quoted excerpt you are about to rely
>   on against the code before its step, and stop and report when one no longer matches: the
>   plan needs refreshing (`/plan-writer refresh`). `Status: needs replanning` means stop at once.
> - `Status: planned`: you are the first. Set `Status: in progress` here and the part's row in `00-overview.md`.
> - Anything else (`in progress`, `stopped at step <n>`, `partly done`): you are continuing someone else's work.
>   Read every entry under `## Execution report`, confirm the last `[x]` step's check still passes (stop and
>   report if not), look at the `[~]` step with `git status` and `git diff`, finish or redo it, never redo `[x]`.
> - `Status: in progress` and you were asked to *execute* (not *continue*): stop and ask the user.
>
> **Keep `## Progress` current:** `[~]` with the date before a step's first edit, `[x]` with the date and a
> one-line note once its check passed. Never mark `[x]` a step whose check you did not see pass.
>
> Read section 1 first and return to it whenever unsure. Do the steps in order, running each check before the
> next; tests you write run in the same step. Build before running tests (`pnpm --filter zelavis run build`
> prints its `tsc` lines; success is exit 0 with no `error TS`). The shell is zsh: use `; echo "exit $?"`, not
> `${PIPESTATUS}`. Do not redesign, rename or improve anything not asked for; match the surrounding style.
>
> **Stop and report instead of improvising** when a cited file or symbol differs from the plan, a check fails for a
> reason that is not a simple mistake in your change, a gate (`check:tigerstyle`, `check:effect-usage`, repo rules,
> parity) would need a suppression, baseline entry, wrapper or shim, the measured renewal cost is above 1 ms, or the
> plan seems to contradict `AGENTS.md` (which wins).
>
> **An unexpected result is a finding, never noise**: investigate it in this session until you know its cause, fix it
> if the fix stays inside this part's files and rules, otherwise report the cause and your proposed fix.
>
> Never: compatibility aliases or fallbacks, silent catches, `try/catch` in Platform code, `Effect.ignore`, unbounded
> concurrency, unchecked `JSON.parse` casts, Promise orchestration in Platform code (tests may use Promises),
> anything in `.claude/`, edits to `dist/`, `website/dist/`, `website/.astro/` or `repos/effect/`, anything in
> `pnotes/`. The working tree has other people's uncommitted changes (dashboard files under
> `packages/zelavis/services/zelavis-ui/`, `AGENTS.md`, `.agents/`): never touch, revert or stage them beyond the
> lines this part names. Do not commit, push or publish.
>
> **Self-audit before you report done** (step 6): re-read your whole diff against sections 1–5 (every change there,
> nothing extra, no one else's file touched); check every item of Done means; rerun every test this part added or
> touched and `pnpm run verify`, after your last edit; search the diff for forbidden patterns, debug output,
> temporary files and TODOs; every unexpected result has a known cause. Fix what you find, rerun, and record the audit.
>
> When you finish or stop, add `### Session <n>: <date>` under `## Execution report` (below earlier entries, which you
> never edit): final status (also update `Status` here and in `00-overview.md`); each step one line; verification
> commands and results, including the measured renewal cost; deviations and why; anything undone; **Context the plan
> lacked** ("none" if nothing). Then give the user the same report, shortened.

## Execution report

### Session 1: 2026-11-03
Status: done.
- Step 1: `leaseFromEnvironment` requires `ZELAVIS_LEASE_TTL_MILLIS` (no 15 s fallback); test added; the hand-built environment in `project-lease-capability.test.mjs` got the TTL.
- Step 2: `deleteProjectWriterLease` plus the `project-writer-lease` deletion participant; idempotency test added.
- Step 3: `test/project-lease-platform.test.mjs` passes (take, renew, audit, release on stop, epoch 2, refusal under another node's live lease, record gone after delete).
- Step 4: `test/project-lease-load.test.mjs`: **renewal: 0.072 ms** (2 000 renewals, 200 leases). Under the 1 ms rule, so the 30 s default stays; 1 000 Projects renew 100 times a second, about 0.7 % of one core.
- Step 5: docs paragraph in `database.md` and the decision record's qualification item removed.
- Step 6: `pnpm run verify` exit 0; `check:tigerstyle` exit 0; docs check exit 0; diff searched for debug output (none; a temporary edit to `dist/` was overwritten by the rebuild).

Deviations (three defects the real-Platform test uncovered, all fixed in files this part touches):
1. **A lease-guarded Project never took its lease.** The Project host starts its engine in a further process with an allow-listed environment that dropped `ZELAVIS_LEASE_*`. Fix: `inheritedProjectLeaseEnvironment` (`_project-lease-environment.ts`) added to the runner's engine environment (`_node-project-runner.ts`). The driver also no longer hands the lease environment to the integration-only host (`_node-project-runtime.ts`): it shares the Project but not its database, and a second claimant of the same lease would have superseded the writer.
2. **A deadlock on start.** The capability check `projectExists` used `projects.get`, which waits for the Project's lifecycle lock, and the start holds that lock while waiting for the lease: every start timed out after 3 s. Fix: `projects.view` (`src/index.ts`).
3. **A refusal reached the Project log as an empty failure.** Tagged errors have no `message`, so the worker reported `Cause([Fail(IntegrationFailure (cause: Error))])`. Fix: `describeFailure` in `effect-boundary.ts`, used for the command reply (`_node-runtime-commands.ts`) and the worker's exit (`_node-runtime-worker.ts`); the log now reads `_tag=LeaseStillHeld partition=leased owner=node-x …`.

Undone: nothing.
Context the plan lacked: the three defects above; the plan assumed the env reached the engine and that `projectExists` was safe during a start. Parts 3 and 4 run a standby Project process under the same environment: a standby must not use `inheritedProjectLeaseEnvironment` blindly (a standby is not the writer).
