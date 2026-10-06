# @zelavis/cloud

Cloud capacity service for Zelavis (not yet wired into the Platform; `private`).

It will implement the `CapacityProvider` contract (`zelavis/provider`) with Alchemy as the provisioning engine, bundled with the Platform and never installed by a self-hoster. Fabric keeps all placement, fencing and draining authority; this service only creates and releases machines. Direction, measurements and open tests: `.agents/references/alchemy-architecture-brief.md`, and "Cloud Capacity And Alchemy" in `AGENTS.md`.

## Today

- [`src/capacity-naming.ts`](src/capacity-naming.ts): deterministic machine names and ownership labels derived from the capacity request. Required because Alchemy's default names live only in its state, so lost state would orphan a machine.
- [`src/provisioning-state.ts`](src/provisioning-state.ts): Alchemy's state store backed by a Zelavis conditional store (the System Store's `setIfAbsent` and `compareAndSet`). One document per stack and stage, so each write is a single-key compare-and-set. `acquire` bumps an epoch and takes ownership; the returned service fails with `StateFenced` once superseded, and Alchemy writes its `creating`/`deleting` intent before any cloud call, so a superseded worker is stopped before it can create or delete anything. Secrets (`Redacted`, such as the generated deploy key) are sealed with AES-256-GCM bound to the document; the codec is required.
- `test/`: a fake Hetzner Cloud API with fault injection (`test/fake-hetzner.mjs`) and a headless Alchemy runner (`test/headless.mjs`), exercised by `test/capacity-scenarios.test.mjs`: idempotent create, destroy, crash between create and state write, state lost entirely, dropped create response, and refusing to delete what it did not create. `test/provisioning-state.test.mjs` and `test/capacity-state.test.mjs` cover the state store alone and under real deploys (fencing, restart recovery, sealing).

- [`src/alchemy-runner.ts`](src/alchemy-runner.ts): runs Alchemy headless with no telemetry, files under a directory we choose, and credentials as in-memory configuration. Never use Alchemy's own entrypoints or `Test/Core` here: they export telemetry to a vendor collector.
- [`src/cloud-port.ts`](src/cloud-port.ts), [`src/hetzner-cloud.ts`](src/hetzner-cloud.ts): one cloud behind a small port. Create and delete through Alchemy; find, list and orphan removal straight to the API.
- [`src/capacity-provider.ts`](src/capacity-provider.ts): `createCapacityProvider`, the `CapacityProvider` implementation. Deterministic node ids, smallest-fit sizing from approved classes, a node ceiling, single-flight per request, ready only after enrollment, and deletes only machines carrying this Platform's labels.

## Not yet

The capacity controller (policy, caps, demand), first-boot data and Agent enrollment tokens, the bundle build with its `import.meta.resolve` patch, and any run against a real cloud.

`alchemy` is a dev dependency: it is bundled at build time and never shipped as a dependency. Pin it exactly and re-verify the scenarios on every bump.

Open for the state store: the secret key's source (the Platform's key management) is not decided, a deletion participant for Project cleanup is not written, `acquire` is not yet tied to a Fabric lease, and values Alchemy does not mark `Redacted` are stored as given.
