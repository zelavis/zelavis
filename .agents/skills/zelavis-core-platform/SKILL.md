---
name: zelavis-core-platform
description: Use when changing the unified Zelavis package, its core runtime/Fabric, built-in App stack, database, Auth, adapters, or trusted product services, especially for authority boundaries, public API shape, and runtime-neutral architecture decisions.
---

# Zelavis Core Platform

Use this skill for changes in:

- `packages/zelavis/src/core`, `src/app`, `src/db`, `src/auth`, `src/platform`,
  `src/backends`, `src/adapters` and `src/sdk`
- `packages/zelavis/services/*` (the first-party product services)
- `zelavis-services/*` when an officially maintained optional service consumes the
  unified package's public contracts

`AGENTS.md` is the rulebook and is always loaded; this skill does not repeat it. It tells
you which sections to read for the area you touch, the lessons that are not written
there, and how to check the work. Where the two seem to differ, `AGENTS.md` wins and
this skill is the one to fix.

## Read first, by area

| You are changing | Read in `AGENTS.md` | And |
|---|---|---|
| Any Platform code | TigerStyle Adaptation; Effect Version & Local Reference Source; Executing Changes; Verification | [TigerStyle](../../references/tigerstyle-typescript.md), [Effect v4 guidance](../../references/effect-v4-guidance.md), `repos/effect/LLMS.md` (`pnpm refs:sync`) |
| A public capability, route, SDK method or CLI command | Endpoint-Backed Capability Rule (JS, HTTP, and CLI parity); Core Access-Control Rule | `test/capability-parity.test.mjs` |
| Service loading, manifests, plugins, frontends, recipes | Service Loading Rules; Platform And App Service Boundary; Package Design Guidance; Marketplace Allow-List | `website/src/content/docs/guides/plugin-api.md` |
| Projects, lifecycle, deletion, recipe upgrades, the app folder | Platform And App Service Boundary | |
| Engine updates, handover, persistent hosts, Agents | Platform And App Service Boundary (handover paragraphs); Repo Structure (installer and updater) | `website/src/content/docs/architecture/updates.md` |
| Fabric, placement, remote shards, failover | Platform And App Service Boundary (Fabric, placement and shard paragraphs) | [two-fabrics placement contract](../../references/two-fabrics-placement-contract.md), [node enrollment design](../../references/node-enrollment-design.md) |
| `zelavis/db` | Database Architecture Rules, in full | [storage engine policy](../../references/storage-engine-policy.md), [Effect Cluster decision](../../references/effect-cluster-decision.md), [offline replication decision](../../references/offline-replication-decision.md), `website/src/content/docs/api/database.md` |
| `zelavis/auth` | Zelavis Auth; Core Access-Control Rule | `src/auth/README.md`, `src/auth/upstream.json` |
| Edge, domains, registrars, previews, TLS | Platform And App Service Boundary (Edge paragraphs); Runtime Independence Rule (previews) | |
| Cloud capacity, providers | Cloud Capacity And Alchemy | [Alchemy architecture brief](../../references/alchemy-architecture-brief.md) |
| Installer, uninstall, worker role, distribution | Distribution Trust Model; Repo Structure | `distribution/README.md` |
| The Assistant | Endpoint-Backed Capability Rule (Assistant rules) | `src/assistant*.ts` |
| Host and runtime bindings | Runtime Independence Rule; Platform And App Service Boundary (adapters and backends) | |

## Where a change belongs

1. **Core** (`src/core`): product-neutral, runtime-neutral contracts and machinery, exported
   through `zelavis/core`, `zelavis/runtime`, `zelavis/fabric`, `zelavis/workload`,
   `zelavis/artifact` and `zelavis/provider`. No product menus, no root Platform policy.
2. **Platform** (`src/platform`): trusted control-plane and product behavior.
3. **App stack** (`src/app`, `src/db`, `src/auth`): reuses the core implementation; never an
   App-private dispatcher or server contract.
4. **Backends** (`src/backends/<id>`): backend policy, capability and intent, with no `node:`
   imports. **Adapters** (`src/adapters`): every host filesystem, process, socket, native,
   command and virtualization effect.
5. **First-party product services** (`packages/zelavis/services/*`): a face, never an
   authority. Removing `@zelavis/auth` costs the settings page, not the ability to sign in.
6. **Optional services** (`zelavis-services/*`): provider and domain capabilities, published
   on their own cycle.

## Lessons not written elsewhere

Each of these cost a real bug or a long detour.

- **The loader must carry everything a plugin declares.** It once built its service object
  field by field and dropped `setup`, so a plugin registering its API there installed with a
  menu and no endpoints, while the same object composed in code worked. The supported path
  was the broken one. Test the installed path, not only the composed one.
- **A first-party service gets no private path.** It is built like a third-party one (a
  `package.json` manifest and the official SDK) and loaded through `loadPluginPackage`. If it
  needs a private way in, the extension point is incomplete: extend the public contract.
- **Core names no capability owned by a product it does not ship.** Core once listed
  `@zelavis/ecommerce:payments` among its capability hints and imported the plugin in its own
  tests, so the Platform could not test itself without a shopping cart. Test core against a
  fixture.
- **A capability owner is recognised by containing a `/`.** `zelavis/auth:oauth` and
  `@acme/shop:payments` name an owner; a bare word stays a Platform domain namespace. Naming an
  owner asks to be considered and grants nothing: discovery stays a flat scan and the owner
  validates.
- **Do not switch features off in code.** There is no `frontend: false`: an installation with
  no frontend has none installed, and the root path says so. A flag that says what a runtime
  *is* is named for that (`role: "platform" | "project"`).
- **Do not add a service kind nothing branches on.** The kind union once drifted to five dead
  kinds while missing `frontend`. Trust is `scope`, never the kind.
- **Prefer narrow exports** over broad `export *` surfaces.
- **Project status refreshes persist under the Project lifecycle permit**, and Fabric fleet
  views stay read-only, so scheduling never re-enters its own Project permit.
- **Remote dispatch reads a request body only after its authority verifies**, and never
  snapshots a Project that already has local runtime data.
- **Root artifacts stay root-owned**: archive extraction must not keep the archive's UIDs.
- **ID-only backend lifecycle dispatch refuses a missing or malformed stored assignment**; only
  the Project manager's explicit stored-record repair may fill one in.
- **The services database refuses startup after an interrupted restore** until the operator
  finishes it with `zelavis services-database restore`.
- **Logical schema transfer** (`schemas.export|import|types`) uses bounded v1 bundles,
  preflights immutable version conflicts, dry-runs by default, and activates only through the
  durable activation workflow.

## Boundary tests that enforce the rules

Keep these green, and read them before changing what they guard:

- `test/capability-parity.test.mjs`: every route has an SDK method and a CLI command.
- `test/backends-host-boundary.test.mjs`: `zelavis/backends` imports no `node:` module (host
  probes come from `src/adapters/_node-backend-host.ts`).
- `test/provider-adapter-boundary.test.mjs`: Alchemy is imported only from the capacity adapter.
- `test/project-host-footprint.test.mjs`: a persistent Project host loads only supervision and
  handover.
- `pnpm check:effect-usage`, `pnpm check:tigerstyle`, `pnpm test:repo-rules`: all in `pnpm verify`.

## Admin Agent (Assistant)

Code lives in `src/assistant*.ts`. Read it before adding a tool. Every tool needs an `access`
requirement, an operator `describe` label and a test, and a tool that changes anything declares
`mutation` so a model's call becomes an approval request instead of an action.

## Design checklist

1. Start from the public API and the authority boundary.
2. Decide where it belongs (above).
3. Define the domain operation and its schemas before any transport or dashboard surface; then
   adapt it to JS, HTTP and CLI together.
4. Keep defaults ergonomic and authority explicit.
5. Register a cleanup participant for any new Project-keyed Platform resource.
6. Update the nearest README and `website/src/content/docs/` when public behavior changes. Open
   follow-ups go into a plan under `.agents/plans/`; `pnotes/TODO.md` only shrinks.
7. Add focused tests in `packages/zelavis/test`, including failure, interruption and recovery
   paths for anything stateful.

## Validation

Run the focused check first, then the gate that counts, from the repository root:

```bash
pnpm --filter zelavis test          # or node --test on the touched test files
pnpm run verify                     # builds, typechecks and tests the whole workspace
pnpm run ci:ui                      # when the dashboard or anything it calls changed
pnpm run docs:check                 # when docs changed
```

Host-operation tests need a real `TMPDIR` on macOS (for example `TMPDIR=/private/tmp/...`),
because the sandbox's `/tmp` symlink fails their path checks.
