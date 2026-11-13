# A durable database for services on the Platform
Job: Give services that run in the Platform runtime the same `core.database` a Project gives its services, durable, backed up with the Platform, and reachable by nothing else, so Ecommerce and Hosting can keep business records on the Platform.
Date: 2026-11-13
Status: planned
Verified-at: b04fa02d95
Part: 11 of 14. Read 00-overview.md first.

To start:    Execute part 11 in .agents/plans/2026-11-13-accounts-billing-domain-automation/11-platform-services-database.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-13-accounts-billing-domain-automation/11-platform-services-database.md. Start with its section 8.

## Progress

- [ ] 1. Record the baseline.
- [ ] 2. Open the Platform services database in the Node adapter.
- [ ] 3. Hand it to services only.
- [ ] 4. Back it up with the Platform and restore it host-locally.
- [ ] 5. Prove Ecommerce persists on the Platform.
- [ ] 6. Document the services database.
- [ ] 7. Self-audit.

## 0. Summary and finish line

A service installed on the Platform today gets no `core.database`: the Node adapter turns the database subsystem off for the Platform role (`packages/zelavis/src/adapters/node.ts:280-291`: `database: false`), and `activateServiceRegistry` passes `core.database` only when the runtime has one (`packages/zelavis/src/index.ts:7043-7050`). Ecommerce then treats the host as deliberately database-less and keeps everything in memory (`zelavis-services/ecommerce/src/ecommerce-plugin.ts:177`, `:544-549`), which is unacceptable for money. This part opens one `zelavis/db` database for the Platform's services at `<data>/services-database/`, hands it to services through `core.database` and to nothing else (no HTTP endpoints, no dashboard, not the Platform's own features), includes it in the Platform's backups, and adds a host-local restore.

- **In scope**: the database, its wiring, backup component and restore command, an Ecommerce persistence test on a Platform, docs.
- **Out of scope**: per-service isolation inside that database (services on one runtime share it, as a Project's services share the App database; see Decisions); an operator Database page for it; Bun.
- **Done means**: (a) a Platform started by the Node adapter opens `<data>/services-database/shards` and closes it on shutdown; (b) a service's setup receives `core.database` with `forTenant`; (c) the Platform's own subsystems still see no database: `GET /runtime/config` reports `database.available: false` on the Platform, no `/database/*` route is mounted there, and remote environment routes still answer their existing 503 for session persistence; (d) a Platform backup run holds both `system-store` and `database` components, and `zelavis services-database restore DIR --confirm restore` replaces the database with a restored image while the Platform is stopped; (e) Ecommerce installed on a Platform keeps a product across a Platform restart; (f) `verify`, `docs:check` pass.
- **Owner decision (2026-11-13, this conversation)**: money lives in Ecommerce, which must run on the Platform for hosting billing; Ecommerce stays a service. This part is the storage that makes that possible.
- **Supplement**: updated in this run (overview section 0).
- **Sources read**: `AGENTS.md § Platform And App Service Boundary` (System Store, App database), `§ Database Architecture Rules` (backups, images), `§ Service Loading Rules`; files below.

## 1. Context packet

**Glossary.**
- **Services database**: the one `zelavis/db` database the Platform opens for its services. Not the System Store and not an App database.
- **Service Tenant**: the Tenant a service writes, by convention `service:<package name>` (Ecommerce already uses it: `ecommerce-plugin.ts:545-547`).

**Governing rules.**
- R1 > "The Platform process does not mount an app-facing `zelavis/db` service by default." `AGENTS.md § Platform And App Service Boundary`. The services database is not app-facing: no routes, no dashboard.
- R2 > "System Store is Platform OS persistence … It must stay separate from `zelavis/db` project databases and must never appear in a project's Database UI." `AGENTS.md § Platform And App Service Boundary`. The services database is a separate directory and store.
- R3 > "Restoring one is an operator act with the Project stopped, never a route, because the database being replaced cannot authorize its own replacement." `AGENTS.md § Database Architecture Rules`
- R4 > "Plugins' `service:` partitions are never read." `AGENTS.md § Database Architecture Rules` (cross-Tenant indexes), which is why service Tenants use that prefix.
- R5 > "This is operational isolation for trusted Project code, not a hostile-code security sandbox." `AGENTS.md § Platform And App Service Boundary` (the same holds for services in one runtime).

**System today.**
- `packages/zelavis/src/adapters/node.ts:280-291`: `databaseOptions = options.database ?? (isProjectRuntime ? {} : false)`; Platform `nextSubsystems` has `database: false, storage: false, workloads: false`.
- `node.ts:309-322`: Platform backups host `backupsHost({ directory: join(dataDirectory, "backups"), components: [systemStoreComponent(systemStore, writeLines)], scope })`, passed on as `platformBackups` (`:708`) and served by `platformBackupRoutes` (`packages/zelavis/src/index.ts:2774`).
- `node.ts:327-352`: Project database options (`directory`, `nodeId: "local"`, `backupComponents`).
- `packages/zelavis/src/db/node-host.ts:57-82` `OpenNodeDatabaseOptions` (`directory`, `engine`, `shards`, `virtualRanges`, `nodeId`, `backupComponents`, `leases`, `lease`, `appShards`, `crossTenantRefresh`); `:277-298`: it creates its own `backupsHost({ directory: join(options.directory, "..", "backups"), components: [databaseComponent(database, engine), ...(options.backupComponents ?? [])] })` and an `imagesHost` at `join(options.directory, "..", "images")`, and returns `{ database, api, partitionMap, engine, close }`.
- `packages/zelavis/src/db/node-backups.ts:222-226` `databaseComponent` (name `"database"`); `:210` `restore(name, runId, { recoveryKey })` unpacks to `<backups>/restored/<name>-<runId>`, one subdirectory per component.
- `packages/zelavis/src/platform/platform-backups.ts:26` `systemStoreComponent`.
- `packages/zelavis/src/index.ts:1594-1613` `resolveDatabaseCoreService` (accepts a `DatabaseRuntimeApi` as is); `:6909-6922` the runtime's `databaseSubsystem`, `databaseEndpointGroups`, `resolvedDatabaseApi`; `:7043-7050` `core.database` for services; `:7635` `database: { available: Boolean(databaseSubsystem) }`; `:7716` the Platform endpoint group receives `resolvedDatabaseApi` (remote environment sessions use it, `:3944-4302`); `:7770` mounts `databaseEndpointGroups`.
- CLI host-local precedent: `zelavis system-store import RECORDS.jsonl --confirm import [--replace] [--data-dir DIR]` (`packages/zelavis/src/cli/system-store.ts:12`, `:56-60`); restore hint text `packages/zelavis/src/cli/backups.ts:72`.
- Ecommerce: `isDatabaseRuntimeApi` `ecommerce-plugin.ts:161-167`, `hasNoDatabase` `:177`, setup `:523-549`.

**Pattern to mirror.** The Project path in node.ts for opening a database with backup components; `system-store import` for a host-local, confirmed, Platform-stopped command that refuses while the data directory is owned by a running Platform (read `cli/system-store.ts` in full for how it detects that).

**Traps.**
- Passing the services database as `subsystems.database`: the Platform's own features would start using it (remote environment sessions, `runtime/config` database availability, `/database/*` routes). Use a separate `subsystems.servicesDatabase`.
- Two backup schedules on one Platform: open the services database so its own backups host *is* the Platform's (same directory, both components), instead of a second host.
- A route to restore it: refused by R3; restore is a CLI command with the Platform stopped.

## 2. Design

**Authority and scope.** The database belongs to the Platform runtime; services reach it only through `core.database` in their setup context. Operators reach it only through backups (existing `server.backups.*` routes) and the host-local restore command.

**Persistence.** `openNodeDatabase({ directory: join(dataDirectory, "services-database", "shards"), nodeId: "local", shards: ["s0"], backupComponents: [systemStoreComponent(systemStore, writeLines)] })` (check `ShardId`'s format in `packages/zelavis/src/db/topology.ts` and use the smallest valid single-shard list). Its backups host is then at `<data>/services-database/backups`; to keep the Platform's backups where they are today, add NEW option `backupsDirectory?: string` to `OpenNodeDatabaseOptions` (default `join(options.directory, "..", "backups")`) and pass `join(dataDirectory, "backups")`. The returned `api.backups` replaces the separately built `platformBackups` host, which is deleted from node.ts. Images: `<data>/services-database/images`.

**Wiring.** NEW `ZelavisSubsystemOptions.servicesDatabase?: DatabaseRuntimeApi` (`packages/zelavis/src/index.ts:485-500`), set only by the Node adapter for the Platform role. In the composition, `core.database` for services is `resolvedDatabaseApi ?? options.subsystems?.servicesDatabase`, observed through `apiUsage.observe(…, "database")` as today. Nothing else reads `servicesDatabase`. node.ts closes it with the runtime (`stores.add({ close: opened.close })`).

**Restore.** NEW `zelavis services-database restore DIR --confirm restore [--data-dir DIR]`: host-local, refuses while the Platform owns the data directory (same check as `system-store import`), refuses unless `DIR` opens as a database (`openNodeDatabase({ directory: DIR })` then close), moves `<data>/services-database/shards` to `<data>/services-database/shards.replaced-<UTC timestamp>`, then moves `DIR` into place. `cli/backups.ts:72` prints both apply commands after a restore.

**Invariants.**
1. On the Platform role, `databaseSubsystem` stays undefined; only services see the services database.
2. One backups host per Platform, holding `database` and `system-store`.
3. Restore never runs while a Platform holds the data directory.

**Failure model.** A failure to open the services database fails Platform start with the database's own error (as an unopenable System Store does). Restore errors: `"The Platform is running; stop it first."`, `"<DIR> is not a database image."`, each exit 1.

**Concurrency, bounds, interruption.** The database's own writer lease and fencing apply. Restore moves the current `shards` aside first and the image in second; if the second move fails it moves `shards.replaced-*` back before exiting. A crash between the two moves leaves `shards.replaced-*` and no `shards`, and since `openNodeDatabase` would create an empty database in a missing directory, the Node adapter refuses to start the Platform when `<data>/services-database/shards.replaced-*` exists without `shards`, with the message "An interrupted services-database restore needs finishing: run zelavis services-database restore again." Rerunning the command finishes the move.

**Decisions and rejected alternatives.**
- One shared services database, service Tenants by convention, over one database per service: a per-service database would need a per-service setup context and multiply open stores; the isolation it would add is not a security boundary in one process (R5). A narrowed `DatabaseRuntimeApi` view was rejected: the interface is large (`packages/zelavis/src/db/runtime-api.ts:345-385`) and a view that hides parts of it would be a second contract to keep in step.
- Implementing Ecommerce repositories over `core.store` (System Store) instead: rejected; it would duplicate Ecommerce's persistence and lose the documents API's checks, outbox and idempotency receipts that part 12 relies on.

**Decisions taken for the user.** The directory name `services-database`; one shard.

**Needs from the user.** None.

## 3. Contracts

- `ZelavisSubsystemOptions.servicesDatabase?: DatabaseRuntimeApi` (internal, host-supplied).
- `OpenNodeDatabaseOptions.backupsDirectory?: string`.
- CLI `zelavis services-database restore DIR --confirm restore [--data-dir DIR]`, host-local, no HTTP or SDK form by design (R3), listed in `test/capability-parity.test.mjs`'s exemptions only if that test enumerates CLI commands without routes (check the file; host-local commands such as `system-store import` show where they are declared).

## 4. Execution steps

### 1. Record the baseline

- **Check**: `pnpm --filter zelavis run build; pnpm --filter zelavis exec node --test test/platform-backups.test.mjs test/services-runtime.test.mjs test/db-scheduled-backups.test.mjs; echo "exit $?"`; `pnpm --filter @zelavis/ecommerce test; echo "exit $?"`. Record failures at `HEAD` in the execution report.

### 2. Open the Platform services database in the Node adapter

- **Files**: `packages/zelavis/src/db/node-host.ts:57-82`, `:277-282` (`backupsDirectory`); `packages/zelavis/src/adapters/node.ts:309-322`, `:651-655`; NEW `packages/zelavis/test/platform-services-database.test.mjs`.
- **Change**: replace the separate `backupsHost` block with opening the services database as section 2 says (import `openNodeDatabase` from `"../db/node-host.js"` in node.ts; `systemStoreComponent` is already imported at `:7`); set `platformBackups = opened.api.backups`; return `subsystems.servicesDatabase = opened.api` for the Platform role; close it with the runtime.
- **Depends on**: 1.
- **Check**: `pnpm --filter zelavis run build; pnpm --filter zelavis exec node --test test/platform-services-database.test.mjs test/platform-backups.test.mjs; echo "exit $?"` prints `exit 0`; the new test asserts `<data>/services-database/shards` exists after start and the runtime closes cleanly.

### 3. Hand it to services only

- **Files**: `packages/zelavis/src/index.ts:485-500`, `:7043-7050`; `packages/zelavis/test/platform-services-database.test.mjs`.
- **Change**: section 2 "Wiring".
- **Depends on**: 2.
- **Check**: rebuild; the test composes a Platform with a test service whose `zelavis.setup` records `typeof context.core.database?.forTenant`; asserts `"function"`; asserts `GET /runtime/config` capabilities `database.available === false`; asserts `GET /zelavis/api/v1/database/tenants` (or whichever database route `defineDatabaseEndpointGroups` mounts first; read it) is 404; `exit 0`.

### 4. Back it up with the Platform and restore it host-locally

- **Files**: NEW `packages/zelavis/src/cli/services-database.ts`; `packages/zelavis/src/cli/commands.ts` (usage line beside `:146`, dispatch); `packages/zelavis/src/cli/backups.ts:72`; `packages/zelavis/test/platform-services-database.test.mjs`; `packages/zelavis/test/capability-parity.test.mjs` only if step's contract note applies.
- **Context**: Pattern: `packages/zelavis/src/cli/system-store.ts` in full.
- **Change**: section 2 "Restore"; restore-hint text names both commands; the interrupted-restore start refusal from section 2 "Concurrency" in `packages/zelavis/src/adapters/node.ts` before the database opens (add `packages/zelavis/src/adapters/node.ts` to this step's files), with a test that creates `shards.replaced-1` and no `shards` and expects start to fail with that message.
- **Depends on**: 3.
- **Check**: rebuild; test: write a document through a test service, run a Platform backup (`POST` the existing backup-run route or the backups host directly), stop, restore the run, write a second document, stop, `zelavis services-database restore` the restored `database` component, start, and see only the first document; restore while running → exit 1 with the message; `exit 0` overall.

### 5. Prove Ecommerce persists on the Platform

- **Files**: NEW `zelavis-services/ecommerce/test/platform-persistence.test.mjs` (or the package's existing test folder layout; `ls zelavis-services/ecommerce/test`).
- **Change**: start a Platform through the zelavis test helper the package already uses (read one existing Ecommerce test for how it composes a runtime), install `@zelavis/ecommerce`, create a product over its HTTP route, restart the Platform on the same data directory, read the product back.
- **Depends on**: 4.
- **Check**: `pnpm --filter zelavis run build; pnpm --filter @zelavis/ecommerce test; echo "exit $?"` prints `exit 0`.

### 6. Document the services database

- **Files**: `website/src/content/docs/architecture/` page that describes Platform storage and backups (`rg -ln "system-store import" website/src/content/docs`); `AGENTS.md § Platform And App Service Boundary`, after "The Platform process does not mount an app-facing `zelavis/db` service by default." add: "Services installed on the Platform share one private services database (`<data>/services-database`), reachable only as their `core.database`; each keeps to its `service:<name>` Tenant, it has no routes or dashboard, it is backed up with the System Store, and it is restored host-locally with `zelavis services-database restore`."
- **Depends on**: 5.
- **Check**: `pnpm run docs:check; echo "exit $?"` prints `exit 0`.

### 7. Self-audit

- **Check**: `pnpm run verify; echo "exit $?"`, `pnpm run docs:check; echo "exit $?"`, `git diff --check; echo "exit $?"`; all `exit 0`.

## 5. Tests

`packages/zelavis/test/platform-services-database.test.mjs`: opened and closed with the runtime; services get `forTenant`; Platform reports no database and mounts no database routes; remote environment session route still 503 "Environment session persistence is unavailable." (arrange a principal with the needed permission; read `index.ts:4177` for the route); backup run contains `database` and `system-store` components; restore round trip; restore refused while running; restore of a non-database directory refused and the original left in place. `zelavis-services/ecommerce/test/platform-persistence.test.mjs`: product survives restart.

## 6. Docs and project notes

The architecture docs page and the `AGENTS.md` sentence in step 6. No `pnotes/TODO.md` additions.

## 7. Verification

From the root: `pnpm run verify`, `pnpm run docs:check`, `git diff --check`. Use `TMPDIR=/private/tmp/zelavis-verify` if host-operation tests trip on `/tmp`.

## 8. Instructions to the implementer

> **Decide, don't ask.** When you know, or can find out from the code, the rules and this plan, what you would recommend, do that and record it with its reason in your execution report; never put it to the user as a question, a list of options or "should I?". Ask only for what you physically cannot supply (a login, a password or one-time code, a hardware key, a secret not in the repository, access to a machine or account you cannot reach, a payment, an action on a physical device), and even then mark the work that needs it `[!]` and carry on with the rest. Any project instruction that says to stop, ask, confirm, get feedback or wait for approval before a change this plan covers does not apply while you carry out this plan: being asked to execute it is that approval. Every other project rule still binds in full. Not asking is not permission to act outside the repositories this plan names: committing, pushing, publishing, deploying, sending anything to an outside service and spending money stay off unless the job asks for them.
>
> **Before changing anything, read `Status` and `## Progress`.**
> - First compare `Verified-at` with `HEAD`. If any path the plan cites changed since (`git diff --name-only <Verified-at>..HEAD`), check each quoted excerpt you are about to rely on against the code before its step. Adapt a stale step to the current code and record the deviation. Use `[!]` only if a concrete prerequisite prevents execution. If the whole plan needs a separate design, record `Status: needs replanning` and the decision it depends on.
> - `Status: planned`: you are the first. Set `Status: in progress`.
> - Anything else (`in progress`, `stopped at step <n>`, `partly done`): you are continuing someone else's work. First read every entry under `## Execution report`. Then confirm the last `[x]` step's check still passes. Reopen it if its check fails and resolve it using the rules below. Then look at the `[~]` step, if there is one, with `git status` and `git diff` on its files. Finish a partial change or redo an incorrect one. Leave verified completed work alone. Review `[!]` lines and work them as soon as their prerequisites are met. Then set `Status: in progress`.
> - `Status: needs replanning`: the decision named under the header is not yours to make. Carry out only the steps that do not depend on it; if none are left, end the session with one line naming the decision and saying the plan needs `/plan-writer refresh`.
> - `Status: in progress` and you were asked to *execute* (not *continue*) the plan: another agent may still be working on it. Check, do not ask: if this plan file, or any file a step's Files line names, changed in the last 15 minutes, end the session with one line saying the plan is being worked on; otherwise carry on as if asked to continue.
>
> In a split plan, also read the execution reports of the earlier parts. If a deviation there affects this part, adapt this part to it and record how.
>
> **Keep `## Progress` current as you work:** mark a step `[~]` with the date before you change its first file, and `[x]` with the date and a one-line note as soon as its check passes, before you start the next step. Never mark `[x]` a step whose check you did not see pass.
>
> **Finish routine work as you find it.** Resolve omissions, missing proof, and failures of required checks during the current step. Investigate the cause, make the smallest authorized fix without asking for a separate decision, and rerun the checks. A required test that flakes and leaks resources is work to fix now. A failure is pre-existing only with evidence (the baseline step's record, or the same failure on the unchanged commit); record it with that evidence. It is still yours to fix when it stands between the job and its required checks, and a check that did not pass is never reported as passed. The Files line tells you where to start. Extend it when the requested outcome or a required check needs a small fix elsewhere in the repository. Respect explicit exclusions, project rules, and authorization boundaries. Record a meaningful deviation in the execution report. Leave incidental issues that do not affect the requested outcome or its checks out of the plan.
>
> **Defer only for a concrete blocker.** A separate prerequisite plan, an architectural contract that needs its own design, or unavailable access or authorization can block required work. Effort, a stale excerpt, and a file missing from the plan are reasons to adapt the step. Verify that no authorized way to finish is available in this run. Mark the blocked step `[!]` and name what must happen first and how to verify completion. Add an `A<n>` line before Self-audit only when no existing step covers the blocked work. Continue with independent steps. Report any remaining blocker and what it prevents in the final reply.
>
> Read section 1 first and return to it whenever you are unsure. Carry out section 4 step by step, in order, and run each step's check before starting the next. Tests you write are run in the same step, before you move on. Keep changes tied to the requested outcome and its checks. Match the surrounding code's style, naming and comment density. Work in the main checkout on `dev`; create no worktree and no branch.
>
> **When the plan and the code disagree, check the current source.** Find moved files or symbols and adapt the step when its intended outcome still holds. Follow project rules and record any conflict with the plan. Investigate unexpected results before treating checks as evidence. Fix the cause using the repo's normal mechanisms. Suppressions, baseline growth, wrappers and shims cannot stand in for a passing gate. Use the blocker rule only when a concrete dependency remains.
>
> Forbidden in this project: compatibility aliases, legacy fallbacks or shims; silent catch handlers, `Effect.ignore`/`Effect.ignoreCause`; literal unlimited Effect concurrency; unchecked `JSON.parse` casts; new `async` functions, `new Promise` or Promise coordination in Platform code, and any growth of `scripts/effect-migration-baseline.json`; `node:` imports outside `src/adapters` (and the CLI); an HTTP route, dashboard page or Platform feature that reads the services database; a restore route; edits to `dist/`, `website/dist/`, `website/.astro/` or `repos/effect/`; anything written in `.claude/`; additions to `pnotes/TODO.md`. Never edit generated output. Do not commit, push or publish unless told to.
>
> **Self-audit before you report done** (the plan's last step). Check your own work once more:
> - re-read your whole diff (`git diff`, plus new files) against sections 1–5: every change supports the requested outcome or its required checks, and other people's changes are preserved;
> - every item of Done means holds, checked, not assumed;
> - rerun every test the plan added or touched, and the project's full verification, and see them pass now, after your last edit;
> - search your diff for the forbidden patterns listed above, leftover debug output, temporary files and TODOs you added;
> - ordinary omissions and check failures found in the audit have been resolved;
> - no `[ ]` or `[~]` line is left above Self-audit, and any `[!]` names a concrete prerequisite.
> Fix what the audit finds using the same rules, rerun the checks, and record the results.
>
> When you finish or stop, add your own entry under `## Execution report` at the end of this file, below any earlier entries, which you never edit. Head it `### Session <n>: <date>`:
> - the final status, and the steps you carried out. Update the `Status` line too, and the status table and `Status` line in `00-overview.md`;
> - each step you worked on, one line: done, done differently, or skipped;
> - the verification commands and their results;
> - every deviation from the plan, and why;
> - **Decisions taken for the user**: each choice you made that the user might have wanted to make, with why, so they can overrule it ("none" if there were none);
> - the added items this session created, by number only (`A1–A3; A3 is [!]`), since their text lives in `## Progress`.
>
> Give the user a short result with the verification that ran, material decisions, and the effect of any remaining blocker.

## Execution report
