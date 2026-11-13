# Fold the cloud capacity service into core
Job: Dissolve `@zelavis/cloud` into the `zelavis` package: its Alchemy/Hetzner driver becomes a capacity adapter behind the `CapacityProvider` contract, loaded only when a provider is connected and never imported by core, Fabric, backends, Edge or the SDK; the operator configures capacity from the dashboard instead of `ZELAVIS_CLOUD_POLICY`; a webhook provider covers datacenters without an API.
Date: 2026-11-13
Status: planned
Verified-at: b04fa02d95
Part: 10 of 14. Read 00-overview.md first.

To start:    Execute part 10 in .agents/plans/2026-11-13-accounts-billing-domain-automation/10-cloud-capacity-in-core.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-13-accounts-billing-domain-automation/10-cloud-capacity-in-core.md. Start with its section 8.

## Progress

- [ ] 1. Record the cloud and package baseline.
- [ ] 2. Move the driver into `src/adapters/capacity` and build its bundle inside `zelavis`.
- [ ] 3. Move the driver's tests and delete the service package.
- [ ] 4. Load the bundle only when a provider is used, and add the boundary test.
- [ ] 5. Store the capacity policy and drop `ZELAVIS_CLOUD_POLICY`.
- [ ] 6. Add the webhook capacity provider.
- [ ] 7. Add SDK and CLI parity.
- [ ] 8. Update the dashboard capacity pages.
- [ ] 9. Update `AGENTS.md`, references and docs.
- [ ] 10. Self-audit.

## 0. Summary and finish line

Today `@zelavis/cloud` (`packages/zelavis/services/zelavis-cloud`, private, 1,475 lines of source) is only the driver that makes Hetzner machines appear: the Platform already owns the controller, policy checks, consent, sealed token, audit, enrollment, routes, SDK, CLI and dashboard (`packages/zelavis/src/platform/cloud-capacity.ts`, `cloud-routes.ts`, `cloud-engine.ts`, `client.cloud`, `zelavis cloud`, Fabric → Infrastructure → Providers). It is packaged as a service nobody installs, and the Platform turns it on only when `ZELAVIS_CLOUD_POLICY` names a JSON file. This part moves the driver into `packages/zelavis/src/adapters/capacity/`, keeps it as one lazily imported bundle, removes the environment variable in favour of a stored policy the operator edits in the dashboard, and adds a `webhook` provider so an operator whose datacenter has no API can let their own automation create machines.

- **In scope**: moving sources, tests and the bundle step; lazy loading; an import-boundary test; stored policy with HTTP/SDK/CLI/dashboard; the webhook provider with its signed protocol; `AGENTS.md § Cloud Capacity And Alchemy` and the references/docs that name the old package or variable.
- **Out of scope**: opening the enrollment listener from the dashboard (it is a start option, `zelavis serve --enrollment-port`, `packages/zelavis/src/cli/commands.ts:354-358`; changing listeners at runtime belongs to the persistent host's live-update design, so the Nodes page keeps its existing notice); more cloud providers (each later provider is another adapter file in the same bundle); real-cloud qualification (`.agents/references/alchemy-architecture-brief.md` keeps its open list); hosting or billing (parts 12 and 14).
- **Done means**: (a) `packages/zelavis/services/zelavis-cloud/` no longer exists and `pnpm-workspace.yaml` needs no change (its `packages/**` glob simply finds one package fewer); (b) `pnpm --filter zelavis run build` produces `packages/zelavis/dist/adapters/capacity/bundle.js` and the packed tarball contains it (`test/published-package.test.mjs`); (c) a Platform started without a cloud connection never loads that bundle, and no module under `dist/core` (which holds Fabric), `dist/backends`, `dist/edge`, `dist/sdk` or `dist/platform` loads anything under `dist/adapters/capacity/` (`test/provider-adapter-boundary.test.mjs`); (d) every former cloud scenario test passes from `packages/zelavis/test/`; (e) `ZELAVIS_CLOUD_POLICY` appears nowhere in source, docs or `AGENTS.md`; an operator sets the policy with `PUT /runtime/cloud/policy`, `client.cloud.setPolicy`, `zelavis cloud set-policy` or the dashboard, and cloud capacity is composed on every Platform that serves an enrollment endpoint; (f) a `webhook` connection provisions, lists and releases machines through a signed request to the operator's HTTPS endpoint, a machine counts as ready only after it enrolls, and only machines this Platform asked for are ever released; (g) parity, browser, `verify`, `ci:ui`, `docs:check` pass.
- **Owner decision (2026-11-13, this conversation)**: "`@zelavis/cloud` should completely dissolve into zelavis core and not be a service at all", with Alchemy kept behind the adapter boundary and loaded only when a provider is connected, so core stays runtime-neutral. The name `@zelavis/cloud` goes with the package; the capability is called cloud capacity, as the routes already are.
- **Supplement**: updated in this run (overview section 0). Its Layout line naming `zelavis-cloud` among bundled services is corrected in step 9.
- **Sources read**: `AGENTS.md § Cloud Capacity And Alchemy`, `§ Runtime Independence Rule`, `§ Service Loading Rules`, `§ Platform And App Service Boundary`; `.agents/references/alchemy-architecture-brief.md`; `.agents/references/node-enrollment-design.md`; `packages/zelavis/services/zelavis-cloud/README.md` and every file below.

## 1. Context packet

**Glossary.**
- **Capacity provider**: an implementation of `CapacityProvider` (`packages/zelavis/src/core/provider/index.ts:45-50`: `list`, `get`, `provision`, `release`). Fabric alone decides placement; a provider only creates and releases machines.
- **Capacity bundle**: the single ES module built from `src/adapters/capacity/` with Alchemy and the Hetzner client inlined (`zelavis`, `effect`, `node:` external), loaded with `import()` by path.
- **Cloud capacity controller**: `createCloudCapacityController` (`packages/zelavis/src/platform/cloud-capacity.ts:139`), which owns the one connection, the sealed token, consent, scale-out and audit.
- **Policy**: what a machine may be (`CloudCapacityPolicy`, `packages/zelavis/src/platform/cloud-engine.ts:29-40`: `location`, `image`, `maxNodes`, optional `allowedLocations`, 1-16 `machineClasses`).
- **Webhook provider**: a capacity provider that asks an operator-run HTTPS endpoint to create or delete machines, for datacenters without an API.

**Governing rules.**
- R1 > "Cloud capacity is a core capability. The capacity controller, provider connections, enrollment and the dashboard flow live in the Platform over the existing `CapacityProvider` contract (`core/provider`). Fabric alone decides allocation, placement, draining and fencing; a provisioning engine only supplies machines and external resources and never becomes a second authority." `AGENTS.md § Cloud Capacity And Alchemy`
- R2 > "host/framework/provider-specific behavior must live only in `adapters/*` or equivalent adapter boundaries … core packages must remain portable and runtime-neutral" `AGENTS.md § Runtime Independence Rule`
- R3 > "Alchemy telemetry is on by default … Never compose its telemetry layer or its `Test/Core` helper in shipped code or tests. Run it only through `makeAlchemyRunner` … The network guard test … must stay green on every Alchemy bump." `AGENTS.md § Cloud Capacity And Alchemy`
- R4 > "Provisioned machine names are deterministic from the capacity request id." and "Zelavis deletes only machines it labeled itself, never adopted or user-enrolled ones." `AGENTS.md § Cloud Capacity And Alchemy`
- R5 > "The installer and any package … install no … " and "a native dependency must never be reintroduced because a server has no compiler" `AGENTS.md § Distribution Trust Model`: the bundle stays pure JavaScript; Alchemy and its clients are dev dependencies, inlined at build.
- R6 > "No runtime compatibility shims. Remove stale shapes and legacy paths outright." `AGENTS.md § Code Change Expectations`

**System today.**
- Driver package `packages/zelavis/services/zelavis-cloud/`: `src/alchemy-runner.ts`, `capacity-error.ts`, `capacity-naming.ts`, `capacity-provider.ts` (imports `zelavis/provider`, `:6`), `cloud-port.ts`, `first-boot.ts`, `hetzner-capacity.ts` (`createHetznerCapacityProvider`), `hetzner-cloud.ts`, `provisioning-state.ts`, `index.ts` (re-exports all nine); `scripts/bundle.mjs` (rolldown, externals `^node:`, `^effect(\/|$)`, `^zelavis(\/|$)`, `^@effect\/platform-bun(\/|$)`, the `import.meta.resolve` stub and `PATCHED_MODULES` marker); tests `test/bundle.test.mjs`, `capacity-naming.test.mjs`, `capacity-provider.test.mjs`, `capacity-scenarios.test.mjs`, `capacity-state.test.mjs`, `first-boot.test.mjs`, `provisioning-state.test.mjs`, helpers `fake-hetzner.mjs`, `headless.mjs`; devDependencies `@distilled.cloud/hetzner` `1.0.0-rc.13`, `@effect/platform-node` `4.0.0`, `alchemy` `2.0.0-beta.81`, `rolldown` `1.2.5`.
- Loader `packages/zelavis/src/platform/cloud-engine.ts`: `readCloudPolicy(file)` `:46-66`; `CloudBundle` `:69-72` (`createHetznerCapacityProvider`, `workerFirstBootScript`); `loadBundle(path)` `:74-79`; `claimCloudAuthority` `:89-100`; `composeCloudCapacity` `:102-145`, which calls `loadBundle` first (`:116`), so today the bundle loads at Platform start.
- Wiring: `packages/zelavis/src/adapters/_node-platform-engine.ts:81-82` passes `cloud: { policyFile: resolve(process.env.ZELAVIS_CLOUD_POLICY), bundlePath: fileURLToPath(new URL("../../services/zelavis-cloud/bundle/index.js", import.meta.url)) }`; `packages/zelavis/src/adapters/node.ts:224` (`cloud?: { bundlePath: string; policyFile: string }`) and `:636-650` (composes when `options.cloud && options.enrollmentEndpoint && systemStore && !isProjectRuntime`).
- Controller: `CLOUD_PROVIDERS = ["hetzner"]` `cloud-capacity.ts:45`; `CloudProviderConfig { provider, token }` `:107-110`; `buildProvider(config, firstBoot)` option `:117`; connection record `ConnectionRecord` (`provider`, `label`, `connectedAt`, `connectedBy`, `tokenHint`, `sealed`) `:59-71`; namespaces `fabric.cloud-connection.v1`, `fabric.cloud-audit.v1`, `fabric.cloud-scaling.v1` `:25-27`.
- Routes `packages/zelavis/src/platform/cloud-routes.ts` (mounted `packages/zelavis/src/index.ts:4718`): `GET /cloud` (`server.cloud.view`), `POST|DELETE /cloud/connection` (`server.cloud.connect`), `GET|PUT /cloud/scaling`, `GET|POST /cloud/nodes`, `DELETE /cloud/nodes/:id` (`server.cloud.manage`); the connect handler requires `provider` and `token` strings (`:58-60`); a missing controller answers `unavailable` (503).
- SDK `ZelavisCloudClient` `packages/zelavis/src/sdk/fetch.ts:1534-1548`, implementation near `:2195`; CLI `packages/zelavis/src/cli/cloud.ts`, dispatched at `packages/zelavis/src/cli/commands.ts:641`.
- Dashboard `packages/zelavis/services/zelavis-ui/app/fabric-pages.ts`: `nodesPage` `:104-144` (manual join command), `cloudPage` `:146-210` (connect form, scale-out consent, machines); provider list `CLOUD_PROVIDERS` in `app/capacity.ts:7`.
- Packaging: `packages/zelavis/package.json:194` lists `"services/zelavis-cloud/bundle"` in `files`; `packages/zelavis/test/published-package.test.mjs:151-154` asserts the bundle ships and the package's other files do not; `packages/zelavis/test/cloud-engine.test.mjs` imports `../services/zelavis-cloud/test/fake-hetzner.mjs` and the bundle path (`:12`, `:14`).
- Package build: `packages/zelavis/package.json:162` (`build`: clean, bootstrap, three bundled service builds, `tsc -p tsconfig.json`, `copy-installation-assets`), `:167` (`typecheck`); `tsconfig.json` includes `src/**/*.ts` with `rootDir: src`, `outDir: dist`.
- Import-footprint pattern: `packages/zelavis/test/project-host-footprint.test.mjs:9-25` (spawn Node with a `registerHooks` load recorder, inspect loaded URLs).

**Pattern to mirror.** The bundle step stays the one in `services/zelavis-cloud/scripts/bundle.mjs`, with input and output paths changed. Lazy loading mirrors `resolveDatabaseCoreService`'s `import("./db/node-host.js")` inside an Effect (`packages/zelavis/src/index.ts:1608`). The webhook provider's request signing mirrors how the Platform seals and audits the token today: the secret is the sealed `token`, never logged.

**Traps.**
- Letting `tsc -p tsconfig.json` compile `src/adapters/capacity/`: `dist/` would then hold modules that import `alchemy`, which is not a dependency of the published package. The folder is excluded from the main config and compiled by its own config into an ignored intermediate directory that only the bundler reads.
- Changing `zelavis/provider` imports in the driver to relative paths: rolldown would inline those Platform modules into the bundle, giving two copies of the contract. Keep the self-reference imports (`from "zelavis/provider"`); the bundle keeps `^zelavis(\/|$)` external, and Node resolves the package's own name through its `exports`.
- "Lazy" that still runs at start: `composeCloudCapacity` must not call `loadBundle` until a provider is first built (connect, a request, scale-out or a list).
- Keeping `ZELAVIS_CLOUD_POLICY` as a fallback "for existing setups": no shim (R6). A stored policy is the only source.
- A webhook endpoint that can make Zelavis delete a machine it never created: release only node ids recorded in this Platform's own `fabric.cloud-webhook-nodes.v1` namespace.
- Following redirects or accepting `http:` for the webhook: https only, `redirect: "manual"` treated as failure, bodies capped.
- Running an operator script on the Platform host instead of a webhook: `AGENTS.md § Platform And App Service Boundary` says "there is no general command runner"; the webhook keeps the operator's automation on their side.

## 2. Design

**Authority and scope.** Unchanged: `server.cloud.view` to read, `server.cloud.connect` to connect, set the policy and set scaling, `server.cloud.manage` to request and release machines, all system scope. The policy moves from a host file to Platform authority in the System Store.

**Layout after the move.**
- `packages/zelavis/src/adapters/capacity/` holds the nine driver files, unchanged except for imports noted in step 2, plus `index.ts` re-exporting them.
- NEW `packages/zelavis/tsconfig.capacity.json`: extends `./tsconfig.json`, `compilerOptions.rootDir: "src/adapters/capacity"`, `outDir: ".capacity-build"`, `declaration: false`; `include: ["src/adapters/capacity/**/*.ts"]`.
- `packages/zelavis/tsconfig.json`: add `"exclude": ["src/adapters/capacity/**"]`.
- NEW `packages/zelavis/scripts/bundle-capacity.mjs`: the old `bundle.mjs` with `input: resolve(root, ".capacity-build/index.js")` and output `dist/adapters/capacity/bundle.js` plus `dist/adapters/capacity/PATCHED_MODULES`.
- `packages/zelavis/package.json`: `build` and `build:runtime` gain `&& tsc -p tsconfig.capacity.json && node scripts/bundle-capacity.mjs` after `tsc -p tsconfig.json`; `typecheck` gains `&& tsc -p tsconfig.capacity.json --noEmit`; devDependencies gain the four pinned packages above; `files` loses `"services/zelavis-cloud/bundle"` (the bundle is inside `dist`, which `files` already ships; confirm with `rg -n '"dist"' packages/zelavis/package.json` and add `"dist/adapters/capacity/bundle.js"` explicitly only if `files` lists dist subfolders rather than `dist`).
- Root `.gitignore` (the package has none): add `packages/zelavis/.capacity-build/`.

**Lazy bundle.** `composeCloudCapacity` no longer takes `bundlePath` from the adapter; node.ts computes `fileURLToPath(new URL("./capacity/bundle.js", import.meta.url))` and passes it. Inside, `const bundle = yield* Effect.cached(loadBundle(options.bundlePath))` and `buildProvider` / `firstBootFor` `yield* bundle` on first use. `claimCloudAuthority` stays at compose (no Alchemy involved).

**Stored policy.** NEW namespace `fabric.cloud-policy.v1`, key `default`, value `{ schemaVersion: 1, policy: CloudCapacityPolicy, updatedAt: number, updatedBy: string }`, written with `compareAndSet` against the observed `updatedAt` (or `setIfAbsent`). `readCloudPolicy(file)` becomes `parseCloudPolicy(value: unknown): Effect<CloudCapacityPolicy, CloudEngineError>` with the same bounds (`MAX_CLASSES = 16`, `MAX_NODES = 100`). The Hetzner provider is built with the stored policy read at build time; with no policy stored, `connect`, `requestNode` and scale-out fail `CloudCapacityError` code `policy-missing` (409). The policy is one shape for every provider: the webhook passes `location`, `image` and the chosen machine class to the endpoint as hints, which an operator fills with their own meanings.

**Webhook provider** (NEW `packages/zelavis/src/platform/cloud-webhook-provider.ts`, runtime-neutral: `fetch` and Web Crypto only). Connection: `provider: "webhook"`, `token` = the operator's signing secret (32-512 printable characters, sealed like any token), NEW `endpoint` (an `https:` URL, ≤ 2048 characters, stored in the connection record in clear; it is not a secret). Requests: `POST <endpoint>` with `content-type: application/json`, body

```ts
type CapacityWebhookRequest =
  | { readonly version: 1; readonly action: "provision"; readonly platformId: string; readonly requestId: string; readonly nodeId: string;
      readonly region?: string; readonly machineClass: { readonly name: string; readonly cpuCores: number; readonly memoryBytes: number; readonly diskBytes: number };
      readonly image: string; readonly location: string; readonly firstBoot: string /* the script the machine must run as root */ }
  | { readonly version: 1; readonly action: "get" | "release"; readonly platformId: string; readonly nodeId: string }
  | { readonly version: 1; readonly action: "list"; readonly platformId: string };
```

and header `zelavis-signature: t=<unix seconds>,v1=<lowercase hex HMAC-SHA256(secret, "<t>.<raw body>")>`. Responses (≤ 256 KiB, validated): `provision`/`get` → `{ node: { id: string; state: "provisioning" | "ready" | "releasing" | "failed"; region?: string } | null }`, `list` → `{ nodes: [...] }`, `release` → `{}`. The provider reports `ready` only when the endpoint says `ready` **and** `enrollment.isEnrolled(nodeId)` holds (same rule as Hetzner, `capacity-provider.ts`). `nodeId` is deterministic from `requestId` through the existing `capacity-naming.ts` helper. Every provisioned node id is recorded in `fabric.cloud-webhook-nodes.v1` (`setIfAbsent`, key = node id) before the request is sent; `release` refuses ids not recorded there and removes the record after a `{}` answer; `list` filters the endpoint's answer to recorded ids. Timeouts: 30 s per call, at most 2 calls in flight per connection. A non-2xx, a redirect, an oversize or invalid body is `provider-failed` with a message that names the status but never the secret or body.

**Invariants.**
1. Nothing outside `src/adapters/` imports a module under `src/adapters/capacity/`; the only importer is `platform/cloud-engine.ts`'s `import()` of the built bundle path, which node.ts supplies (enforced by `test/provider-adapter-boundary.test.mjs`).
2. A Platform that never builds a provider never loads the bundle (same test).
3. The policy has one source: the stored record.
4. A webhook release only ever names a node this Platform recorded before asking for it.
5. Secrets (Hetzner token, webhook secret) stay sealed except inside the provider call; the webhook secret is used only as an HMAC key.

**Failure model.** Existing `CloudCapacityError` codes plus NEW `policy-missing` (409, "Set the capacity policy first."). Webhook failures map to the existing `provider-failed` (502). `PUT /cloud/policy` with an invalid body → 400 `invalid-request` with `parseCloudPolicy`'s message; a stale `expectedUpdatedAt` → 409 `invalid-request` with "The policy changed; reload it."

**Concurrency, bounds, interruption.** The bundle load is cached once per process. A crash after recording a webhook node id but before the provision call leaves a recorded id with no machine: the next `list` (scale-out loop) calls `get`, and a `null` answer removes the record. Policy writes are single CAS writes.

**Deleted.** `packages/zelavis/services/zelavis-cloud/` (all of it), `ZELAVIS_CLOUD_POLICY`, `readCloudPolicy(file)`, the `cloud.policyFile` adapter option, `services/zelavis-cloud/bundle` in `files`.

**Decisions and rejected alternatives.**
- Keep a bundle rather than adding Alchemy as a runtime dependency of `zelavis`: Alchemy unbundled is 1.3 GB, needs the `import.meta.resolve` patch, and the installer installs with scripts off; inlining keeps the published package small and dependency-free (R5).
- Webhook rather than a script runner: no command execution on the Platform host.
- Policy stays one shape for every provider: fewer forms, and the webhook gets the same machine classes the scale-out logic chooses from.

**Decisions taken for the user.** The webhook protocol shape above (versioned `1`, Stripe-style signature header), 30 s timeouts, and that a webhook machine must enroll before it counts as ready.

**Needs from the user.** None.

## 3. Contracts

| HTTP (relative to the API base) | Access | SDK (`client.cloud.…`) | CLI (`zelavis cloud …`, `--json`) |
| --- | --- | --- | --- |
| `GET /runtime/cloud/policy` → `{ policy: CloudCapacityPolicy \| null, updatedAt?: number }` | `server.cloud.view` | `policy()` | `policy` |
| `PUT /runtime/cloud/policy` `{ policy: CloudCapacityPolicy, expectedUpdatedAt?: number }` → same as GET | `server.cloud.connect` | `setPolicy(policy, { expectedUpdatedAt? })` | `set-policy --data JSON [--expected-updated-at N]` |
| `POST /runtime/cloud/connection` gains `endpoint?: string` (required when `provider: "webhook"`, refused otherwise) and `provider` accepts `"webhook"` | `server.cloud.connect` | `connect({ provider, token, label?, endpoint? })` | `connect --provider webhook --endpoint URL --token SECRET` (NEW `--endpoint` in `VALUE_FLAGS`, `packages/zelavis/src/cli/cloud.ts:11`) |
| `GET /runtime/cloud` connection summary gains `endpoint?: string` for webhook connections | `server.cloud.view` | unchanged | unchanged |

`CloudCapacityPolicy` as in `cloud-engine.ts:29-40`, moved unchanged. `CloudProviderConfig` becomes `{ readonly provider: CloudProviderId; readonly token: string; readonly endpoint?: string }`; `CLOUD_PROVIDERS = ["hetzner", "webhook"] as const` in both `cloud-capacity.ts` and the dashboard's `app/capacity.ts` (`{ id: "webhook", label: "Your own automation (webhook)" }`).

## 4. Execution steps

### 1. Record the cloud and package baseline

- **Files**: none.
- **Check**: from the repository root, `pnpm --filter @zelavis/cloud test; echo "exit $?"` and `pnpm --filter zelavis exec node --test test/cloud-engine.test.mjs test/published-package.test.mjs; echo "exit $?"` (after `pnpm --filter zelavis run build`). Record each suite that fails at `HEAD` in the execution report with its output; those are pre-existing only with that record.

### 2. Move the driver into `src/adapters/capacity` and build its bundle inside `zelavis`

- **Files**: `git mv packages/zelavis/services/zelavis-cloud/src packages/zelavis/src/adapters/capacity`; NEW `packages/zelavis/tsconfig.capacity.json`; `packages/zelavis/tsconfig.json`; NEW `packages/zelavis/scripts/bundle-capacity.mjs` (from `git mv packages/zelavis/services/zelavis-cloud/scripts/bundle.mjs`); `packages/zelavis/package.json`; root `.gitignore`; `packages/zelavis/src/adapters/node.ts:224`, `:636-650`; `packages/zelavis/src/adapters/_node-platform-engine.ts:81-82`.
- **Context**: section 2 "Layout after the move"; Traps 1-2. In `bundle-capacity.mjs` set `const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")` (the `packages/zelavis` directory), `input: resolve(root, ".capacity-build/index.js")`, `outDirectory = resolve(root, "dist/adapters/capacity")`, and write `bundle.js` there; keep the externals list and the `stub-import-meta-resolve` plugin byte for byte.
- **Change**: only the bundle's location changes in this step. In `_node-platform-engine.ts:82` replace the `services/zelavis-cloud/bundle/index.js` URL with `new URL("./capacity/bundle.js", import.meta.url)` (the file lives in `dist/adapters/`, so the bundle is its sibling folder). `node.ts` and `cloud-engine.ts` keep their current options until step 5 removes `policyFile`.
- **Depends on**: 1.
- **Check**: `pnpm --filter zelavis run build; ls packages/zelavis/dist/adapters/capacity/bundle.js; cat packages/zelavis/dist/adapters/capacity/PATCHED_MODULES; ls packages/zelavis/dist/adapters/capacity; echo "exit $?"` from the root shows `bundle.js`, a patched count of at least 1, only `bundle.js` and `PATCHED_MODULES` in that directory, and `exit 0`. `pnpm --filter zelavis run typecheck; echo "exit $?"` prints `exit 0`.
- **Stop if**: Node cannot resolve `zelavis/provider` from the bundle at `dist/adapters/capacity/bundle.js` (self-reference needs the package `exports` to list `./provider`; check `rg -n '"./provider"' packages/zelavis/package.json`). If it is listed and still fails, record the error and switch the driver's two `zelavis/provider` imports to `import type` only where they are types; if a value import remains, mark the step `[!]` with the error.

### 3. Move the driver's tests and delete the service package

- **Files**: `git mv` each of `packages/zelavis/services/zelavis-cloud/test/{bundle,capacity-naming,capacity-provider,capacity-scenarios,capacity-state,first-boot,provisioning-state}.test.mjs` to `packages/zelavis/test/capacity-{bundle,naming,provider,scenarios,state,first-boot,provisioning-state}.test.mjs`, `fake-hetzner.mjs` to `packages/zelavis/test/_fake-hetzner.mjs`, `headless.mjs` to `packages/zelavis/test/_alchemy-headless.mjs`; `packages/zelavis/test/cloud-engine.test.mjs:12`, `:14`; `packages/zelavis/test/published-package.test.mjs:151-154`; delete `packages/zelavis/services/zelavis-cloud/` (README, package.json, tsconfig.json, node_modules link) with `git rm -r`; `pnpm install` to refresh the lockfile.
- **Context**: test imports change from `../dist/...` of the service to `../dist/adapters/capacity/bundle.js` for bundle-level tests, and to the intermediate `../.capacity-build/<file>.js` only where a test exercised an unbundled module (check each file's imports; prefer the bundle, which exports everything `index.ts` re-exports). `published-package.test.mjs` now expects `services/` without `zelavis-cloud` and `dist/adapters/capacity/bundle.js` shipped, and `.capacity-build/` not shipped.
- **Depends on**: 2.
- **Check**: `pnpm install; pnpm --filter zelavis run build; pnpm --filter zelavis exec node --test test/capacity-*.test.mjs test/cloud-engine.test.mjs test/published-package.test.mjs; echo "exit $?"` prints `exit 0` and the same test count the baseline recorded for the moved files.

### 4. Load the bundle only when a provider is used, and add the boundary test

- **Files**: `packages/zelavis/src/platform/cloud-engine.ts`; NEW or extended `packages/zelavis/test/provider-adapter-boundary.test.mjs` (part 7 may have created it for `_dns-cloudflare.js`; extend it); `packages/zelavis/test/cloud-engine.test.mjs`.
- **Context**: section 2 "Lazy bundle"; Trap 3. Pattern P: `project-host-footprint.test.mjs:9-25`.
- **Change**: `Effect.cached` the load; `buildProvider` and `firstBootFor` acquire it. The boundary test has two cases: (1) spawn Node with the load recorder and import `dist/core/index.js`, `dist/backends/index.js`, `dist/edge/index.js`, `dist/sdk/fetch.js` and `dist/platform/cloud-engine.js`; assert no loaded URL contains `/dist/adapters/capacity/`, `/dist/adapters/_dns-` or `/dist/adapters/_registrar-`; (2) start a Platform through `test/_runtime.mjs` with an enrollment endpoint and no connection, call `GET /runtime/cloud`, and assert through the recorder that `/dist/adapters/capacity/bundle.js` was not loaded. In `cloud-engine.test.mjs` add: compose with a bundle path that does not exist → compose succeeds; connecting then fails `provider-failed` "The cloud bundle could not be loaded.".
- **Depends on**: 3.
- **Check**: `pnpm --filter zelavis run build; pnpm --filter zelavis exec node --test test/provider-adapter-boundary.test.mjs test/cloud-engine.test.mjs; echo "exit $?"` prints `exit 0`.

### 5. Store the capacity policy and drop `ZELAVIS_CLOUD_POLICY`

- **Files**: `packages/zelavis/src/platform/cloud-engine.ts:29-66`, `:102-145`; `packages/zelavis/src/platform/cloud-capacity.ts` (policy read/write, `policy-missing`); `packages/zelavis/src/platform/cloud-routes.ts` (two routes); `packages/zelavis/src/adapters/node.ts:224`, `:636-650`; `packages/zelavis/src/adapters/_node-platform-engine.ts:81-82`; `packages/zelavis/test/cloud-engine.test.mjs`, `packages/zelavis/test/cloud-capacity.test.mjs`, `packages/zelavis/test/cloud-api.test.mjs`.
- **Context**: section 2 "Stored policy"; section 3 rows 1-2.
- **Change**: in node.ts replace the `cloud?: { bundlePath: string; policyFile: string }` option with `cloud?: false` and compose when `options.cloud !== false && options.enrollmentEndpoint && systemStore && !isProjectRuntime`, passing `bundlePath: fileURLToPath(new URL("./capacity/bundle.js", import.meta.url))` (add `import { fileURLToPath } from "node:url";` unless `rg -n "fileURLToPath" packages/zelavis/src/adapters/node.ts` finds it) and no policy; delete the `ZELAVIS_CLOUD_POLICY` spread in `_node-platform-engine.ts:81-82`; `composeCloudCapacity` loses its `policy` option. Then `parseCloudPolicy`; the controller's `policy()` / `setPolicy(policy, principalId, expectedUpdatedAt?)` with an audit entry `action: "policy.set"`; `buildProvider` receives the policy; routes as section 3, mirroring the scaling routes in the same file (`:85-115`) for shape, access and error mapping.
- **Depends on**: 4.
- **Check**: `rg -n "ZELAVIS_CLOUD_POLICY|policyFile" packages/zelavis/src; echo "exit $?"` prints `exit 1` (no matches); `pnpm --filter zelavis run build; pnpm --filter zelavis exec node --test test/cloud-engine.test.mjs test/cloud-capacity.test.mjs; echo "exit $?"` prints `exit 0`.

### 6. Add the webhook capacity provider

- **Files**: NEW `packages/zelavis/src/platform/cloud-webhook-provider.ts`; `packages/zelavis/src/platform/cloud-capacity.ts` (`CLOUD_PROVIDERS`, `CloudProviderConfig.endpoint`, connection record `endpoint`); `packages/zelavis/src/platform/cloud-engine.ts` (`buildProvider` dispatch: `hetzner` → bundle, `webhook` → `createWebhookCapacityProvider`, which never loads the bundle); `packages/zelavis/src/platform/cloud-routes.ts:58-60`; NEW `packages/zelavis/test/cloud-webhook-provider.test.mjs`; `packages/zelavis/test/cloud-api.test.mjs`.
- **Context**: section 2 "Webhook provider"; Traps 5-7.
- **Change**: `export const createWebhookCapacityProvider = (options: { readonly endpoint: string; readonly secret: string; readonly platformId: string; readonly store: ZelavisSystemStore; readonly policy: CloudCapacityPolicy; readonly firstBoot: (nodeId: string) => Promise<string>; readonly isEnrolled: (nodeId: string) => Promise<boolean>; readonly fetch?: typeof fetch; readonly now?: () => number }): CapacityProvider`. Imports: `import { Effect } from "effect";`, `import type { CapacityProvider, ZelavisCapacityNode } from "../core/provider/index.js";`, `import type { ZelavisSystemStore } from "../system-store.js";`, `import { integration } from "../core/runtime/effect-boundary.js";`. HMAC through `crypto.subtle.importKey("raw", …, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])`. The `CapacityProvider` methods return Promises because the contract does; build each as an Effect and run it once at that boundary (`Effect.runPromise`), as `cloud-engine.ts` does for `firstBootFor`.
- **Depends on**: 5.
- **Check**: `pnpm --filter zelavis run build; pnpm --filter zelavis exec node --test test/cloud-webhook-provider.test.mjs test/provider-adapter-boundary.test.mjs; echo "exit $?"` prints `exit 0`; `pnpm run check:effect-usage; echo "exit $?"` from the root prints `exit 0`.

### 7. Add SDK and CLI parity

- **Files**: `packages/zelavis/src/sdk/fetch.ts:1534-1548` and the implementation near `:2195`; `packages/zelavis/src/cli/cloud.ts`; `packages/zelavis/test/capability-parity.test.mjs` only if the new routes need a declaration there (they should not: SDK and CLI cover them).
- **Depends on**: 6.
- **Check**: `pnpm --filter zelavis run build; pnpm --filter zelavis exec node --test test/capability-parity.test.mjs; echo "exit $?"` prints `exit 0`.

### 8. Update the dashboard capacity pages

- **Files**: `packages/zelavis/services/zelavis-ui/app/fabric-pages.ts:146-210`; `packages/zelavis/services/zelavis-ui/app/capacity.ts:7`; the browser suite that covers the providers page (`rg -n "infrastructure/providers" packages/zelavis/services/zelavis-ui/scripts packages/zelavis/services/zelavis-ui/test` to find it).
- **Change**: a "Machine policy" card before the provider card (location, image, maximum nodes, machine classes as rows of name/CPU/memory GB/disk GB with add/remove, saved with `PUT /runtime/cloud/policy` and the read `updatedAt`); the connect form shows an "Endpoint (https)" field when the webhook provider is chosen, the label "Signing secret" instead of "API token", and this help text: "Zelavis sends a signed request to this address whenever it needs a machine created or deleted. Your automation creates the machine and runs the first-boot script it receives; the machine counts as ready once it joins." Native DOM only, `context.run` for writes.
- **Depends on**: 7.
- **Check**: `pnpm --filter @zelavis/ui typecheck; echo "exit $?"`, `pnpm --filter @zelavis/ui test; echo "exit $?"`, `pnpm run ci:ui; echo "exit $?"`, all `exit 0`, with a browser case: set a policy, choose the webhook provider, connect to a local fake endpoint the suite starts, and see the connection row show the endpoint host.

### 9. Update `AGENTS.md`, references and docs

- **Files**: `AGENTS.md § Cloud Capacity And Alchemy` (lines 231-250 at this commit); `.agents/references/alchemy-architecture-brief.md` (`:34`, `:42`, `:112`); `.agents/references/node-enrollment-design.md:112`; `.agents/references/plan-writer.md:55`; `website/src/content/docs/architecture/node-enrollment.md:209-210`; the docs page that lists cloud operations (`rg -ln "runtime/cloud" website/src/content/docs`).
- **Change**: in `AGENTS.md` replace the decision paragraph's first sentence with: "Decision (2026-10-06, revised 2026-11-13). The provisioning code, fenced state store and `CapacityProvider` implementations live in `packages/zelavis/src/adapters/capacity` and are built into one bundle inside the `zelavis` package (`dist/adapters/capacity/bundle.js`) that the Platform imports by path only when a provider is first used; a Platform composes cloud capacity whenever it serves an enrollment endpoint, and the operator sets the machine policy through `/runtime/cloud/policy`. They pass against a fake Hetzner API; real-cloud behavior is not yet proven." Replace "shipped in a bundled first-party cloud service, never in the core runtime and never as something a self-hoster installs" with "shipped inside the `zelavis` package as a capacity adapter, never imported by core, Fabric, backends, Edge, Platform or SDK modules (`test/provider-adapter-boundary.test.mjs`), and never something a self-hoster installs". Add a bullet: "Operators whose datacenter has no API connect the `webhook` provider: Zelavis sends signed, versioned requests to their HTTPS endpoint and releases only machines it asked for." In the references and docs, replace paths and the environment variable accordingly; the supplement's Layout line drops `zelavis-cloud` from the bundled services.
- **Depends on**: 8.
- **Check**: `rg -n "zelavis-cloud|@zelavis/cloud|ZELAVIS_CLOUD_POLICY" AGENTS.md .agents/references website/src packages --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/CHANGELOG.md'; echo "exit $?"` prints `exit 1`; `pnpm run docs:check; echo "exit $?"` prints `exit 0`.

### 10. Self-audit

- **Check**: `pnpm run verify; echo "exit $?"`, `pnpm run ci:ui; echo "exit $?"`, `pnpm run docs:check; echo "exit $?"`, `git diff --check; echo "exit $?"`; all `exit 0`.

## 5. Tests

- `test/capacity-*.test.mjs` (moved): every scenario the service had (idempotent create, destroy, crash between create and state write, lost state, dropped create response, refusing to delete what it did not create, sealing, fencing, the `import.meta.resolve` patch count) passes unchanged in substance; only import paths differ.
- `test/provider-adapter-boundary.test.mjs`: the two cases in step 4; plus part 7/9 entries for `_dns-cloudflare.js` and `_registrar-namecheap.js` if those parts have landed.
- `test/cloud-engine.test.mjs`: compose with a missing bundle succeeds and fails only on first use; stored policy round trip; `policy-missing` before a policy exists; invalid policy → 400 message names the bound.
- `test/cloud-webhook-provider.test.mjs` (a local `node:http` server as the endpoint, the provider given `fetch` that rewrites `https://webhook.test` to it, since the Platform path requires `https:`): provision sends a correctly signed body (recompute the HMAC in the test); the node stays `provisioning` while the endpoint says `ready` until `isEnrolled` returns true; `release` of an id never provisioned is refused without a request; a 302 answer, a 500, a body over 256 KiB and a malformed body each give `provider-failed` without the secret in the message; a `null` `get` after a crash-like gap removes the recorded id; `http:` endpoint refused at connect with 400.
- Routes (`test/cloud-api.test.mjs`): `PUT /runtime/cloud/policy` without `server.cloud.connect` → 403; with a stale `expectedUpdatedAt` → 409; webhook connect without `endpoint` → 400; Hetzner connect with `endpoint` → 400.
- Browser (step 8): policy form, webhook connect, at desktop and mobile sizes.

## 6. Docs and project notes

`AGENTS.md § Cloud Capacity And Alchemy`, `.agents/references/alchemy-architecture-brief.md`, `.agents/references/node-enrollment-design.md`, `.agents/references/plan-writer.md`, `website/src/content/docs/architecture/node-enrollment.md` and the cloud operations docs page, as step 9 says. The `AGENTS.md` edit records an owner decision taken in this conversation; quote it in the execution report. No `pnotes/TODO.md` additions.

## 7. Verification

From the root: `pnpm run verify`, `pnpm run ci:ui`, `pnpm run docs:check`, `git diff --check`. Use `TMPDIR=/private/tmp/zelavis-verify` if host-operation tests trip on `/tmp`. Inspect new untracked files separately.

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
> Forbidden in this project: compatibility aliases, legacy fallbacks or shims (no `ZELAVIS_CLOUD_POLICY` fallback, no re-export from the old path); silent catch handlers, `Effect.ignore`/`Effect.ignoreCause`; literal unlimited Effect concurrency; unchecked `JSON.parse` casts; new `async` functions, `new Promise` or Promise coordination in Platform code, and any growth of `scripts/effect-migration-baseline.json`; `node:` imports outside `src/adapters` (and the CLI); a static import of anything under `src/adapters/capacity/` from any other module; Alchemy's telemetry layer, its own entrypoints or `Test/Core`; Alchemy, `@distilled.cloud/*` or `rolldown` as runtime `dependencies` of `zelavis`; React for a dashboard page; edits to `dist/`, `website/dist/`, `website/.astro/` or `repos/effect/`; anything written in `.claude/`; additions to `pnotes/TODO.md`; provider tokens or webhook secrets in logs, responses or error messages; contacting a real cloud from tests. Never edit generated output. Do not commit, push or publish unless told to.
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
