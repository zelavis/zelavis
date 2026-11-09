<!-- plan-writer supplement
verified-at: 53c038e024
verified-on: 2026-11-05
lessons-through: 2026-11-09
sources:
  - AGENTS.md
  - .agents/skills/plan-writer/SKILL.md
  - scripts/test/claude-folder.test.mjs
  - .agents/skills/zelavis-core-platform/SKILL.md
  - .agents/skills/zelavis-dashboard-ui/SKILL.md
  - .agents/skills/zelavis-release-maintainer/SKILL.md
  - .agents/skills/zelavis-repo-maintainer/SKILL.md
  - .agents/references/tigerstyle-typescript.md
  - .agents/references/effect-v4-guidance.md
  - package.json
  - pnpm-workspace.yaml
  - packages/zelavis/package.json
  - packages/zelavis/services/zelavis-ui/package.json
  - packages/zelavis/services/zelavis-ui/scripts/test-route-parity.mjs
  - .github/workflows/ci.yml
-->

# Zelavis Plan-Writer Supplement

The project supplement for the general `plan-writer` skill,
`.agents/skills/plan-writer/SKILL.md` (Claude Code: `/plan-writer <job>`). The skill is
project-neutral and lives here so `.agents/` holds every source. It wins over the skill where
they conflict, and `AGENTS.md` wins over both. Without Claude Code, attach this file together
with the skill's `SKILL.md`.

## 1. Project in brief

A self-hostable App Platform, pre-release with no users (`AGENTS.md § Project Vision`). It is
written in TypeScript, with Effect `4.0.0` pinned for asynchronous orchestration
(`packages/zelavis/package.json`). It has its own multi-model database `zelavis/db`, uses Fabric
and Agents for placement, and has a native Fuzor dashboard (`@zelavis/ui`). Node is the
production host, and Bun has an adapter (`AGENTS.md § Runtime Independence Rule`).

## 2. Layout

Workspaces: `packages/**`, `zelavis-services/**`, `examples/*` and `website`
(`pnpm-workspace.yaml`).

- `packages/zelavis`: the unified package.
  - `src/core` holds runtime-neutral contracts and Fabric.
  - `src/platform` holds the trusted control plane.
  - `src/app` is the built-in App stack.
  - `src/adapters` holds host bindings.
  - `src/sdk` is the SDK.
  - `test/*.test.mjs` are its tests.
- `packages/zelavis/services/*`: first-party services bundled with the Platform.
  - `zelavis-app` is the `@zelavis/app` recipe.
  - `zelavis-ui` is the dashboard.
  - `zelavis-ui-legacy` is reference only: never fix it or depend on it.
  - The others are `zelavis-auth`, `zelavis-marketplace` and `zelavis-cloud`.
- `packages/create-zelavis`: the create bootstrap.
- `zelavis-services/*`: optional services published to npm on their own release cycle, such as
  the recipes (wordpress, drupal, joomla and others), `ecommerce` and `auth-oidc`.
- `examples/*`: framework examples. `website/`: public docs. `distribution/`: installer and
  release staging. `pnotes/`: a private roadmap repository, never published.

(`AGENTS.md § Repo Structure`)

## 3. Read before planning

- `AGENTS.md`, in full.
- The skills the job touches: `.agents/skills/zelavis-{core-platform,dashboard-ui,release-maintainer,repo-maintainer}/SKILL.md`
  (`.agents/skills/plan-writer/SKILL.md` is the general skill this supplement extends).
- Every `.agents/references/*` file `AGENTS.md` links from the sections the job touches. For
  Platform code, always include `tigerstyle-typescript.md`.
- For Effect work: `repos/effect/LLMS.md`, `effect-v4-guidance.md`, and the Effect source and
  tests for each API used. Run `pnpm refs:sync` if the checkout is missing.
- `pnotes/TODO.md`, if present.

## 4. Rules every decision is held to

- **No backward compatibility**: no aliases, shims, fallbacks, legacy branches, or migrations
  from retired layouts (`AGENTS.md § Code Change Expectations`).
- **No workarounds** around `check:tigerstyle`, `check:effect-usage`, repo rules or the parity
  test. Migrate touched legacy code and add its file to `migratedFiles` (`AGENTS.md § Effect Version`).
- **Authority comes first**: principal, permission or grant, scope (system, Project, service,
  Tenant), invariants, bounds, and crash behavior for every state change
  (`AGENTS.md § TigerStyle Adaptation`, `§ Core Access-Control Rule`).
- **Boundaries** (`AGENTS.md § Platform And App Service Boundary`):
  - Platform vs Project runtime;
  - System Store vs Project database;
  - control plane vs data plane;
  - runtime-neutral core (no `node:` imports) vs `adapters`;
  - Fabric is the one placement authority;
  - the dashboard is a client.
- **JS, HTTP and CLI parity**: one domain operation exposed through the SDK, `/zelavis/api/v1/`
  and the CLI together. Plugin APIs use `plugins.<namespace>`
  (`AGENTS.md § Endpoint-Backed Capability Rule`).
- **Scalability is rule one** for database and Fabric work. Cost follows the number of changes,
  never the number of Tenants. Use bounded concurrency (`AGENTS.md § Database Architecture Rules`).
- **Database rules** (`AGENTS.md § Database Architecture Rules`):
  - writes go through the documents API;
  - checks run inside the transaction;
  - the log is appended before lenses are projected;
  - a transaction covers one partition;
  - cross-partition work is a workflow.
- **Effect v4** for asynchronous orchestration (`Effect.fn`/`Effect.gen`, typed failures, scoped
  finalizers). Synchronous code stays plain TypeScript (`AGENTS.md § Effect Version`).
- **Cleanup**: anything keyed by Project identity registers a Project deletion participant
  (`AGENTS.md § Platform And App Service Boundary`).

## 5. Contracts in Zelavis terms

- Effect `Schema` definitions for inputs, outputs, persisted records and errors (error tags).
- Operation definition: resource and action, HTTP method and path, access requirement, handler.
  The SDK lives in `packages/zelavis/src/sdk`.
- CLI command and flags, `--json` output, and how each failure tag maps to HTTP status, SDK error
  and CLI exit code.
- Dashboard: a Fuzor screen or `fuzor-island` in `packages/zelavis/services/zelavis-ui/app`. No
  React except the Glide grid. State goes in the URL (`?sidebar=` and query keys), menus declare
  a `surface`, and pages call public endpoints (`AGENTS.md § UI Package Rules`).
- Dashboard shell and views: `index.html` owns the frame and startup never replaces it.
  Locally rendered URL-backed views use Fuzor's `data-fuzor-view-query` / `data-fuzor-view-value`
  / `data-fuzor-view-values`, recognized by `router.isViewNavigation`, with no per-page query
  exceptions (`AGENTS.md § UI Package Rules`).

## 6. Tests

- `packages/zelavis/test/*.test.mjs` run with `node --test` (`packages/zelavis/package.json`),
  using helpers such as `_platform.mjs`, `_database.mjs` and `_runtime.mjs`.
- Tests import the built output (`../dist/...`), so build first: `pnpm --filter zelavis run build`,
  then `node --test test/<file>.test.mjs` from `packages/zelavis`. The build prints its `tsc`
  script lines; success is exit 0 with no `error TS` line (lesson: follower-failover-removals-drill).
- Recipe runtime failures are tested by wrapping the real local Agent runner:
  `test/recipe-project-runtime.test.mjs` → `setup(t, { agent })` and
  `test/recipe-contract2.test.mjs` → `setup(t, first, { strict })`. The plan controller is tested
  directly in `test/recipe-plan-controller.test.mjs` → `setup`, `makeHost` and `failureOf`.
- Dashboard tests are `packages/zelavis/services/zelavis-ui/tests/*.test.mjs`. Browser tests use
  Playwright (`@playwright/test`'s `chromium`, driven by plain scripts rather than the Playwright
  test runner): `packages/zelavis/services/zelavis-ui/scripts/test-{service-ui,server-views,route-parity,embedded-server-views}.mjs`,
  run by its `test:browser` script and from the root by `pnpm run ci:ui`. A new page adds its
  pattern to `app/dashboard-routes.ts` so the route parity suite visits it at desktop and
  mobile sizes; a new flow extends the suite that covers its area
  (`packages/zelavis/services/zelavis-ui/package.json`, `AGENTS.md § UI Package Rules`).
- A real Platform with a real remote Agent on one machine: `test/project-failover.test.mjs` (Platform behind a plain
  HTTP server, `createRemoteProjectAgent` with an `openssl` certificate, trust read from the System Store) and
  `test/remote-project-agent.test.mjs` (a test-made Ed25519 trust key with `createHttpsProjectDispatcher`).
- A TLS Agent hosting remote App shards for one test file: `test/_remote-shard-fixture.mjs` → `startRemoteShardAgent`
  (`commit`, `access`, `engine`, `restart`, `closeAgent`); a real Platform with a remote Agent behind a cuttable proxy and a real
  `@zelavis/app` Project: `test/app-shard-remote.test.mjs` → `setup` (lesson: remote-shard-reads-and-replicas planning).
- Failure paths and crash/recovery cases are required. New state machines get seeded model tests
  with reproducible seeds (`AGENTS.md § TigerStyle Adaptation`).
- `packages/zelavis/test/capability-parity.test.mjs` must cover a new operation. A new dashboard
  page adds its pattern to `packages/zelavis/services/zelavis-ui/app/dashboard-routes.ts`.

## 7. Gates and verification

Run everything from the repository root, never from a package (`AGENTS.md § Verification`).

- `pnpm run verify` always runs, and covers:
  - `check:effect-source`, `check:effect-usage`, `check:tigerstyle` and `test:repo-rules`;
  - build, typecheck and test (`package.json`).
- `pnpm run ci:ui` when the dashboard changed.
- `pnpm run docs:check` when docs changed.

## 8. Docs and notes

- Update `website/src/content/docs/` and package READMEs when public API or architecture changes.
- Update `AGENTS.md` and `.agents/` together when durable guidance changes.
- `pnotes/TODO.md`: remove completed items, add open follow-ups and limits, and keep no record of
  completed work (`AGENTS.md § Repo Structure`).

## 9. Traps

- Express or Hono-style handlers → define one operation and let the transports adapt it.
- Promise chains or `async` orchestration → Effect.
- `try/catch` with logging → a typed failure.
- A React route → a Fuzor screen.
- Reading before the transaction → check inside it.
- A per-Tenant loop → a change-driven design.
- A shim to keep old data working → delete it and recreate development Projects.
- Typing a database step as `Effect<…, DbError>` → check its real failures first: a drain
  (`router.drained`) fails with `PlacementInUse`, which is not part of `DbError`
  (`packages/zelavis/src/db/errors.ts`; lesson: follower-failover-removals-drill).
- Writing anything in `.claude/` → never, not even a link: guidance, skills, references and plans
  live only in `AGENTS.md` and `.agents/`; `scripts/test/claude-folder.test.mjs` (in
  `pnpm test:repo-rules`) fails on anything there but `settings.local.json` and `worktrees/`
  (`AGENTS.md § Agent Instruction Source Of Truth`). This binds the plan writer too: the
  supplement, the plans and the plan-writer skill live only in `.agents/`. If step 0 finds one of
  them in `.claude/` (a `plan-writer.md`, a `plans` or `references` folder or link, a copy of the
  skill), move any real file not already in `.agents/` to its `.agents/` place, remove the
  `.claude/` entry, and say so in section 0 of the plan.
- A new Platform record keyed by Project identity without a deletion participant → register one
  beside `project-placement-authority` and `app-data-placement` in `src/index.ts`
  (`AGENTS.md § Platform And App Service Boundary`).
- Reading a Project during its start with `projects.get` → use `projects.view`: a start holds the Project's lifecycle
  until it is ready, and `get` waits on it (lesson: project-failover-and-shard-placement).
- A new `ZELAVIS_*` variable for a Project's engine process → add it to the allow-list the host hands its engine
  (`src/adapters/_node-project-runner.ts` → `inheritedProjectLeaseEnvironment`, `src/adapters/_project-lease-environment.ts`
  → `PROJECT_LEASE_VARIABLES`); otherwise it never reaches the engine (lesson: project-failover-and-shard-placement).
- Platform → remotely placed Project traffic → the signed `route` dispatch: the Agent, not the Platform, signs the
  Project's Gateway envelope (`src/adapters/_remote-project-agent.ts` → `route`; lesson: project-failover-and-shard-placement).
- Tests that kill Project processes → select them from `GET /runtime/debug/processes` by their Project directory: the
  listing holds every Project process on the machine (lesson: project-failover-and-shard-placement).
- `zelavis/db` handles: `forTenant("service:…")` is allowed; `forPart` throws `UnknownPart` synchronously on an undivided
  Tenant; `openNodeDatabase` answers `database` (Effect API) and `api` (Promise API) (lesson: project-failover-and-shard-placement).
- Planning on a Docker drill (`pnpm release:qualify:*`) → run it once at `HEAD` first;
  `release:qualify:failover` takes `ZELAVIS_QUALIFY_DRILLS=<names>` and `ZELAVIS_QUALIFY_KEEP=1`
  (`distribution/scripts/qualify-failover.mjs`; lesson: follower-failover-removals-drill).

- Citing a plan the job names → check it still exists in `.agents/plans/`: finished plans are deleted by planning runs, so take
  their decisions from the reference they fed (for remote shards, `two-fabrics-placement-contract.md`) (lesson:
  remote-shard-reads-and-replicas planning).
- Freshness by `git diff <Verified-at>..HEAD` alone → also `git status --porcelain`: large features can sit untracked in the working
  tree (the whole remote-shard implementation did on 2026-11-08), invisible to a commit diff (lesson: remote-shard-reads-and-replicas planning).
- Giving a read a typed failure for a store or transport problem → reads die on store errors (`src/db/errors.ts` →
  `dieUnlessMoving`: only `TenantMoving` and domain errors fail), so a remote read path must die the same way (lesson:
  remote-shard-reads-and-replicas planning).

- Assuming a read is a pure function of database bytes because it performs no writes → inspect its transitive use of
  writer-owned memory. `getVectorIndex` returns a mutable in-memory index, and similarity and hybrid queries can consult it
  even when `approximate` is omitted (`src/db/document-reads.ts` → `findDocuments`, `inSimilarityOrder`; lesson:
  02-shard-reader-and-tenant-reads). Test the same request after building and changing the index.
- Serializing `Schema.TaggedError` by enumerating fields → `Error.cause` is non-enumerable; check required schema fields and
  round-trip them (`src/db/errors.ts` → `StoreError`; lesson: 02-shard-reader-and-tenant-reads).
- Running a build while the full verification tests use `dist/` → the build cleans that directory and causes unrelated
  module-not-found failures; run builds and full verification sequentially (lesson: 02-shard-reader-and-tenant-reads).

- A new database route → also update the route inventory in `test/db-database-service.test.mjs` ("the database service
  mounts the same routes on the db runtime API") and the CLI usage string, besides the parity test (lesson:
  remote-shard-reads-and-replicas, part 5).
- Asserting a tagged refusal by its message → assert its fields (`ShardOperationInvalid.reason`, `_tag`) (lesson:
  remote-shard-reads-and-replicas, part 5).
- A Node identity from the database → `openNodeDatabase`'s origin is `local`; the Project's Node comes from its
  authenticated channel (the Project capability's `node`) (lesson: remote-shard-reads-and-replicas, part 5).
- A follower pass that reports `more` (`FollowerPass.more`) → run another pass before pausing, or a quiet copy stays
  behind after a burst (lesson: remote-shard-reads-and-replicas, part 4).
- Deleting a finished part file of a split plan before its overview is `done` → never: later parts lose the execution
  reports they hand over from (lesson: remote-shard-reads-and-replicas, part 4).

## 10. Forbidden patterns

Never in the implementer block or the plan:
- compatibility aliases or legacy fallbacks;
- silent catches or `Effect.ignore`;
- unbounded concurrency;
- unchecked `JSON.parse` casts;
- Promise orchestration in Platform code;
- edits to generated output (`dist/`, `website/dist/`, `website/.astro/`) or `repos/effect/`;
- anything written in `.claude/`.
