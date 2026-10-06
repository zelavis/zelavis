# Cloud capacity and Alchemy in Zelavis

Date: 2026-10-06
Status: proposal. Nothing here is implemented. A reduced spike (section 6) confirms the approach.
Supersedes the earlier, broader Alchemy brief.

`AGENTS.md` is guidance the owner may revise. This brief does not change any rule by itself; section 7 lists the revisions it expects.

## 1. Decision

- **Alchemy is the default engine for cloud provisioning, shipped in a bundled first-party cloud service, not in the core runtime.** The Platform's capacity controller, provider connections, enrollment and dashboard flow stay in core over the existing `CapacityProvider` contract. The bundled service implements that contract with Alchemy. Self-hosters install nothing.
- If the spike (section 6) fails, fall back to a narrow adapter on the `@distilled.cloud/*` clients (the same team's lower layer, which Alchemy is built on). Do not hand-roll a general engine.
- **A local deploy tool** (for example `npm create zelavis` or `zelavis deploy --provider hetzner`, run through `npx`) uses Alchemy to take a user with a cloud token and no server to a running install: server, SSH key, firewall, volume and DNS, re-runnable and removable, with cloud-init running the ordinary `install.sh`.
- Fabric keeps placement, leases, fencing, draining and routing. Alchemy supplies machines and resources that Fabric then places onto; it never decides what runs where.

Why this changed from the earlier version: the objections (native dependencies, weight) were checked against the package. All Alchemy peer dependencies are optional, and the native `rolldown` and `libsql` code appears only in the bundling, Docker, Fly, Workers and libSQL-state paths, not in the Hetzner server, firewall, volume or DNS resources. `rolldown`'s bindings are prebuilt platform packages and need no compiler. The remaining risks are the ~140 MB unpacked size, beta status, and fit with Fabric's ownership model. Rebuilding Alchemy's engine (about 10k lines of plan, apply, state, diff and drift) and its provider long tail is a poorer use of effort than adopting it, if it passes the spike.

Watch for the opposite failure: do not let Alchemy become a second authority. Its state is provisioning state only.

### Existing servers are the primary path

Server creation is optional everywhere. Anyone with a machine already running (any VPS, bare metal, on-premises, or a cloud server they made by hand) skips it entirely:

- **First install:** the user runs the ordinary `install.sh` on their own server. No cloud token, no provider, no Alchemy.
- **More capacity:** an existing machine joins as a Node by installing the Agent and enrolling with a one-time token. This needs no cloud provider at all, so it works for any host, including ones no provider supports.
- **Cloud features are additive.** Connecting a provider (section 5a) only adds adopt-this-server conveniences (firewall, DNS) and automatic scale-out. Without it, everything else works.
- Fabric treats an enrolled machine the same whether Zelavis created it or the user did; only machines Zelavis created carry its label and may be deleted by it. An adopted or user-enrolled machine is never deleted by the adapter.

The local deploy tool and the capacity adapter's `provision` are for users who want Zelavis to create servers. They must never be a prerequisite.

## 2. What belongs where

| Area | Owner |
|---|---|
| Capacity controller, policy, provider connections, enrollment, dashboard flow | Zelavis core, over the existing `CapacityProvider` contract |
| Creating and deleting machines (and volumes, DNS records if needed) | Bundled cloud adapter service, one adapter per cloud |
| Placement, leases, fencing, epochs, dispatch, draining | Fabric and Agents |
| Load balancing, firewall, edge cache | Fabric and Edge |
| Tenant routing, shard movement | App Data Fabric |
| First server for a new installation (optional) | Operator-side stack; the official `install.sh` stays the normal path |
| External resources a recipe declares (later) | Adapters on the same clients |

An App never touches a cloud or a credential. It asks Fabric for capacity inside its allocation.

## 3. Existing contract

`packages/zelavis/src/core/provider/index.ts` already defines `ZELAVIS_PROVIDER_V1`, `defineProvider`, `capacityProviderCapability` and `CapacityProvider` (`list`, `get`, `provision`, `release`). Its comments already say providers create and release Nodes only and Fabric decides placement. Build on it. The interface is Promise-based at its boundary; Effect-based internals adapt at that edge.

## 4. How an adapter works

- **provision:** create a server through the cloud API using a stable name and a label derived from `requestId`, plus a cloud-init script that runs the official `install.sh` in Agent-only mode with a short-lived, single-use enrollment token. Return a `provisioning` Node at once. It becomes `ready` only after the Agent enrolls and Fabric verifies identity, version, architecture, backend and health.
- **Idempotency:** `requestId` is the key. Before creating, look up servers by label, so a crash between cloud creation and saving the result neither duplicates nor orphans a machine.
- **release:** only after Fabric reports the Node drained and fenced. Delete the server; delete or retain volumes by connection policy. A failed delete is recorded and retried, and the Node stays `releasing` until it is confirmed gone.
- **list / get:** read servers by label. Fabric compares them with its records to report orphans and drift. Repair happens only where policy allows.

Adding a cloud means another adapter with the same four methods.

## 5. Dashboard and connections

- "Add cloud provider" is a client of Platform endpoints, with equal SDK, HTTP and CLI operations.
- A connection holds an encrypted credential (never returned or logged), allowed regions and machine classes, a node cap and a cost cap. Connecting a provider does not authorize unlimited spend.
- The adapter validates the token and lists regions and sizes through the client.
- A provisioned VM is not a Node until enrollment succeeds. A failed enrollment stays non-schedulable and retryable.
- Scale-out: shortfall, bounded capacity intent, provision, enroll, committed placement, Agent readiness. Deduplicate demand while a machine boots, and apply cooldowns and quotas. Scale-in: drain, fence, release.

## 5a. Wizard: detect and adopt an existing server

When `install.sh` has already put Zelavis on a server, the setup wizard may offer to connect the cloud it runs on. It is the same operation as "Add cloud provider", with a better start:

1. The Platform reads the host's instance metadata endpoint and suggests the cloud as a hint only (not verified for every cloud).
2. The user supplies a token. The adapter validates it and proves the token can see this machine by matching the instance id. That match is the proof, never the hint.
3. Idempotent steps, each optional: register this machine as an owned Node; open ports 80 and 443 in the cloud firewall; create the DNS record for the hostname already collected; save the connection and its limits for later scale-out.

The adapter gains `detect` and `adopt` beside `list`, `get`, `provision` and `release`. This needs no Alchemy engine; it is a handful of idempotent calls on the client. The wizard and the dashboard call the same endpoints, with SDK and CLI equivalents.

### Credential model

A control plane holding a provider token is the industry baseline (Coolify, Dokploy and autoscalers do the same). Keep the protections modest:

- say plainly in the wizard what the token can do
- recommend, not require, a dedicated cloud project
- encrypt at rest; never return or log it
- delete only resources carrying Zelavis's own label
- audit every use
- scale-out consent is separate from the firewall and DNS conveniences, so a user can let Zelavis open its own ports without letting it spend money
- approval above a threshold is a possible later addition

### License

Alchemy is Apache-2.0 (copyright Functionless Corp.), which permits commercial use and bundling. Keep its `NOTICE` and `THIRD_PARTY_LICENSES` in the shipped bundle, and check the final bundle's dependency list for LGPL: the installed tree contained one LGPL-3.0-or-later package (`@img/sharp-libvips-*`, via `sharp`) that the bundle should not include. Pin the exact version: already-released Apache-2.0 versions stay Apache-2.0 if the project's terms change later.

## 6. Spike (decides Alchemy versus the narrow fallback)

Facts checked against npm on 2026-10-06:

- `alchemy@2.0.0-beta.81`: about 140 MB unpacked; every peer dependency is optional; `rolldown` and `libsql` code is confined to the bundling, Docker, Fly, Workers and libSQL-state paths (by reading the package, not by running it).
- Engine core is about 10k lines (Plan 2.4k, Apply 2.2k, State 2.3k, Output 0.8k, Provider 0.8k, Drift 0.6k, Resource 0.5k, Diff 0.3k). Hetzner `Server.ts` alone is about 1.1k lines of per-resource edge cases.
- `@distilled.cloud/hetzner@1.0.0-rc.13`: about 3.7 MB, depends only on `@distilled.cloud/core`; same maintainers and organization as Alchemy.

The spike answers:

1. Do the Hetzner server, firewall, volume and DNS resources load and apply on a server installed with scripts off and no compiler, without loading the bundler? What is the resident size?
2. Can a Zelavis-backed state store give one active apply per graph, and can a stale worker be stopped from applying after losing ownership?
3. Can it run supervised, cancellable and headless as a long-lived service rather than a CLI session?
4. Does cloud-init `user_data` carry Agent enrollment end to end on a disposable machine, and does a crash between create and result-save leave no duplicate or orphan?
5. Which other clouds you want (DigitalOcean, AWS, others) have providers, and which need a custom one? DigitalOcean was not established.

Outcome: if 1 to 4 pass, ship Alchemy in the bundled cloud service. If 1 to 3 fail, build the narrow adapter on the clients. If only 4 fails, fix the enrollment path first; it is not an Alchemy question.

### Spike results (2026-10-06, macOS arm64, Node 24, scratch directory)

Run: `npm install alchemy@2.0.0-beta.81 effect@4.0.0 --ignore-scripts`, then import the engine and Hetzner resources.

| Question | Result |
|---|---|
| 1. Installs with scripts off | Pass. 153 packages, 53 s, no compiler involved. Not yet tried on Linux without a compiler. |
| 1. Loads without the bundler | Pass. Importing Hetzner `Server`, `Firewall`, `Volume`, `RecordSet`, `Providers` and the engine (`Plan`, `Apply`, `Provider`, `Resource`, `Stack`, `Diff`) loaded none of `rolldown`, `libsql`, `workerd` or the other clouds' clients (resolve hook). Load cost: ~380 ms, ~90 MB RSS. |
| 1. Install size | Unbundled: **1.3 GB** on disk (see bundle measurement below for the bundled size). All cloud clients are hard dependencies: `@distilled.cloud/gcp` 278 MB, `aws` 206 MB, `cloudflare` 105 MB, plus `workerd` 129 MB and the 295 MB package itself. The Hetzner client alone is 3.9 MB. |
| 2. State store seam | Feasible. `StateService` is a small interface (`get`, `set`, `delete`, `list`, `listStacks`, `listStages`, `getOutput`, `setOutput`, `getReplacedResources`, `deleteStack`, `getVersion`). It has no lock or conditional write. Locking is each store's job (the Postgres store uses an advisory lock with a 5 s trusted-lease TTL, so a lost lease can still write inside that window). A Zelavis store must add its own conditional, epoch-checked writes. Built-in stores include in-memory, local, HTTP and Postgres. Not tested end to end. |
| 3. Headless, supervised, cancellable | Not tested. It loads as a library, but no real apply was run. |
| 4. cloud-init enrollment, crash between create and save | Not run. Needs a disposable cloud machine and a token. |
| 5. Providers | Alchemy ships AWS, GCP, Cloudflare, Hetzner, Fly, Railway, Neon, PlanetScale, Prisma, Kubernetes, Docker and others. **No DigitalOcean, Vultr or Linode** (checked directory names), so DigitalOcean needs a custom provider. |

### Bundle measurement (same day, no cloud token)

Entry point exporting the engine (`Stack`, `Plan`, `Apply`, `Deploy`, `Destroy`, `Provider`, `State`) plus Hetzner `Server`, `Firewall`, `Volume`, `RecordSet` and `Providers`, bundled with rolldown (`effect` and `node:` left external, matching the host-provided rule).

| Measurement | Result |
|---|---|
| Installed footprint, unbundled | 1.3 GB |
| Bundle | **824 KB** across 8 files, minified. The Hetzner API client is tree-shaken in. |
| Other clouds' code in the bundle | None: no AWS, GCP or Cloudflare endpoints, no `libsql`. A JS wrapper for the bundler (about 115 KB) is included but its native binding is not, and it is only loaded if the bundling feature is used. |
| Runs with only `effect` beside it | Yes, after one patch. 239 ms to load, 122 MB RSS. |
| The patch | A module-scope `import.meta.resolve("alchemy/Local/Sidecar")` (dev-mode sidecar code that tree-shaking cannot drop) fails outside the package. A 6-line build plugin replaces `import.meta.resolve(` with a stub. This disables Alchemy's local dev sidecars, which we do not use. We would own this patch and re-verify it on every Alchemy version bump. |

Loading is not the same as working. No apply, destroy, state write or provider call has been exercised through the bundle.

### Reading

The two worries are mostly resolved. Native code does not load, and the 1.3 GB footprint collapses to under 1 MB when bundled, which is how services already ship. The state seam is workable. What remains is behavioral, and nothing here is proven yet: a real apply and destroy, fencing in a Zelavis-backed state store, the headless supervised run, the crash between create and state-write, and cloud-init enrollment. Alchemy stays the default for the bundled cloud service. The narrow adapter on the 3.9 MB Hetzner client remains the fallback if the behavioral tests fail.

Also keep in mind: Alchemy is beta, so pin the exact version, own the bundle patch, and expect churn. DigitalOcean needs a custom provider.

### Results against a fake Hetzner API (same day, no token)

A fake Hetzner Cloud API (servers, SSH keys, actions, with fault injection) was driven through a real, headless Alchemy `deploy` and `destroy` with Alchemy's `Hetzner.Server` provider, an in-memory state store with injected write failures, and the API endpoint overridden through `HCLOUD_ENDPOINT`. The fake, the headless runner and the scenarios now live in `packages/zelavis/services/zelavis-cloud` (`@zelavis/cloud`, private, not yet wired into the Platform build) and run as `node --test`: 14 tests, about 5 seconds, no network.

| Scenario | Result |
|---|---|
| Create, then rerun the same stack | Pass. One server, one `createServer` call, rerun is a no-op. |
| Destroy | Pass. Server and its generated deploy key both removed. |
| State write fails right after the cloud create (the exact crash window) | Pass. State keeps a `creating` row; a retry finds the server and creates nothing. |
| Create committed but the response never arrives | Pass. The retry hits the name conflict and adopts the existing server: one server. |
| **Crash after create and the state is lost entirely** | **Fail with Alchemy's default naming.** The physical name carries a random suffix that lives only in state, so a redeploy created a second server and left an orphan (and a second key). |
| Same, with a deterministic `name` derived from the capacity request id | Pass. The redeploy adopts the existing server by name: one server, one key. |
| Destroy with an unrelated server present | Pass. Only its own server was deleted. |

What this changes:

- **Deterministic names are mandatory.** The cloud service must pass `name` derived from the `requestId` (and labels), never rely on Alchemy's generated names. Without it, any loss of provisioning state creates an orphan that nothing will ever delete or bill-proof.
- **State durability is the real safety net**, which is why the Zelavis-backed store (conditional, epoch-checked writes, written before any dependent action) matters more than the engine itself. Alchemy records a `creating` row before the cloud call, which is what makes the common crash recoverable.
- **Headless operation works**, but needs `@effect/platform-node` (an optional peer). It must be bundled with the service, because only `zelavis` and `effect` are host-provided. The bundle grew from 824 KB to 900 KB with it.
- The scenarios still need confirming against real Hetzner (rate limits, eventual consistency, real error shapes, 409 behavior), and cloud-init enrollment has not been tried at all.

### Zelavis-backed state store (built, tested against the fake)

`packages/zelavis/services/zelavis-cloud/src/provisioning-state.ts`. One System Store document per stack and stage, so every write is a single-key `compareAndSet` (the store has no multi-key transaction). `acquire` bumps an epoch and records the owner; the service it returns is bound to that owner and epoch and fails with `StateFenced` on any read or write once superseded.

Held by tests (32 in the package, about 10 seconds): 24 concurrent writes lose no update; a superseded worker is fenced on read, write and delete and changes nothing; a worker superseded before it starts is stopped at Alchemy's `creating` write, so it reaches no cloud (0 servers created); a stale `destroy` cannot delete the new owner's machine; a restarted worker recovers a crash after the cloud create without creating again; compare-and-set conflicts retry a fixed 16 times then fail with `StateContention`; a malformed stored document is reported as `StateCorrupt`.

Findings that changed the design:

- **Alchemy's own encoder stores `Redacted` values in the clear**, including the generated deploy SSH key. The store seals them (AES-256-GCM, bound to the document so a sealed secret cannot be moved) and a stored document contains no private key material.
- **The secret codec must be required, not optional.** A secret first appears after the cloud has acted (the deploy key exists once the machine does), so "fail closed when there is no codec" fired after a machine and key already existed. Construction now refuses to run without a codec.
- A worker that deleted the stack itself must read it as empty afterwards, not as fenced.

Open: where the secret key comes from (the Platform's key management), tying `acquire` to a Fabric lease, a deletion participant for Project cleanup, and values Alchemy does not mark `Redacted` are stored as given.

### Telemetry (found while building the runner)

Alchemy's own entrypoints add a telemetry layer that is **on by default** and exports traces, metrics and logs to `https://otel.alchemy.run`, tagged with a persistent user id, the git root commit, hashed origin and branch, OS, architecture, CPU count and memory. It also writes `~/.alchemy/id`. It is disabled by `ALCHEMY_TELEMETRY_DISABLED`, `DO_NOT_TRACK` or `NO_TRACK`, or a persisted file.

The first spike driver and the first version of the package tests ran through Alchemy's `Test/Core.deploy`, which includes that layer, so those runs likely sent telemetry; `~/.alchemy/id` and `~/.alchemy/profiles` were created at the time of the first run. The package now runs through `makeAlchemyRunner` (`src/alchemy-runner.ts`), which composes none of it, sets the opt-out, points `ALCHEMY_HOME` and Alchemy's working directory at a directory we choose, and supplies credentials through an in-memory `ConfigProvider` rather than `process.env`. Tests hold this: every request during a deploy goes to the cloud API host (with a negative control proving the observer sees stray requests), the token is not in `process.env`, and nothing is written to the process cwd.

### CapacityProvider (built, tested against the fake)

`createCapacityProvider` (`src/capacity-provider.ts`) over a `CloudPort` (`src/cloud-port.ts`), with `createHetznerCloud` (`src/hetzner-cloud.ts`) as the first port: create and delete go through Alchemy; find, list and the last-resort delete of an orphan go straight to the Hetzner API. Held by 13 provider tests: node id is the deterministic machine name; the smallest approved class that fits is chosen and an impossible request is refused; the same or concurrent requests produce one machine; a node ceiling refuses new machines but never an existing request; a running machine is `provisioning` until the Platform has verified its Agent; `get` and `list` show only machines this Platform labeled; release removes the machine and its key, is idempotent, refuses (and leaves alone) a machine it did not create, and still removes its own machine when provisioning state was lost; a crash after the cloud create is recovered by provisioning again without a second create.

Open: first-boot data and the enrollment token (the Agent installer command and a single-use token are not designed), the orphan deploy key when state is lost, policy and caps living in the capacity controller, wiring into the Platform build and allow-list, and everything against a real cloud.

### Next spike steps (need a disposable Hetzner project and token)

1. Confirm the fake-API scenarios (now a repo test suite) against one disposable real Hetzner project, and replace the in-memory state with the Zelavis-backed conditional, epoch-checked store.
2. Force a crash between create and state write; confirm no duplicate or orphan after retry (label lookup).
3. Run supervised, cancellable and headless as a long-lived service.
4. Boot a machine with cloud-init that runs `install.sh` in Agent-only mode and enrolls.
5. Repeat the install and bundle on Linux with no compiler.

## 7. AGENTS.md revisions expected

- State that cloud capacity provisioning is a core capability built on the capacity contract, with bundled first-party adapters.
- Note that Alchemy is an optional operator tool, not a Platform dependency.
- Leave every Fabric, Agent, fencing and data rule unchanged.

## 8. Rejected

- Alchemy inside the core runtime, or powering all project creation. Most of creation is local and involves no external resource.
- Rebuilding Fabric's reconciliation on Alchemy, or a Zelavis-hosted Alchemy state store.
- Alchemy as a custom runtime for application artifacts, and the Vite environment work. Both need artifact admission contracts that are not scheduled.

## 9. Later

- Recipe-declared external resources (bucket, DNS, database) on the same clients, with a checkpointed deletion participant that retains shared dependencies.
- The local deploy tool (section 1) is a named deliverable, built on Alchemy and run through `npx`.
- `Zelavis.Project` as an Alchemy provider, using the public SDK only, with an explicit ownership binding for adoption.
