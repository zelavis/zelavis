# @zelavis/cloud

Cloud capacity service for Zelavis (`private`). The Platform side (`packages/zelavis/src/platform/cloud-capacity.ts`, `cloud-routes.ts`, SDK `client.cloud`, `zelavis cloud`) loads the bundle this package builds (`bundle/index.js`, `scripts/bundle.mjs`) through `platform/cloud-engine.ts` when `ZELAVIS_CLOUD_POLICY` is set. `createHetznerCapacityProvider` is the one entry it calls.

It implements the `CapacityProvider` contract (`zelavis/provider`) with Alchemy as the provisioning engine, bundled with the Platform and never installed by a self-hoster. Fabric keeps all placement, fencing and draining authority; this service only creates and releases machines. Direction, measurements and remaining qualification: `.agents/references/alchemy-architecture-brief.md`, and "Cloud Capacity And Alchemy" in `AGENTS.md`.

## Today

- [`src/capacity-naming.ts`](src/capacity-naming.ts): deterministic machine names and ownership labels derived from the capacity request. Required because Alchemy's default names live only in its state, so lost state would orphan a machine.
- [`src/provisioning-state.ts`](src/provisioning-state.ts): Alchemy's state store backed by a Zelavis conditional store (the System Store's `setIfAbsent` and `compareAndSet`). One document per stack and stage, so each write is a single-key compare-and-set. `acquire` bumps an epoch and takes ownership; the returned service fails with `StateFenced` once superseded, and Alchemy writes its `creating`/`deleting` intent before any cloud call, so a superseded worker is stopped before it can create or delete anything. Secrets (`Redacted`, such as the generated deploy key) are sealed with AES-256-GCM bound to the document; the codec is required.
- `test/`: a fake Hetzner Cloud API with fault injection (`test/fake-hetzner.mjs`) and a headless Alchemy runner (`test/headless.mjs`), exercised by `test/capacity-scenarios.test.mjs`: idempotent create, destroy, crash between create and state write, state lost entirely, dropped create response, and refusing to delete what it did not create. `test/provisioning-state.test.mjs` and `test/capacity-state.test.mjs` cover the state store alone and under real deploys (fencing, restart recovery, sealing).

- [`src/alchemy-runner.ts`](src/alchemy-runner.ts): runs Alchemy headless with no telemetry, files under a directory we choose, and credentials as in-memory configuration. Never use Alchemy's own entrypoints or `Test/Core` here: they export telemetry to a vendor collector.
- [`src/cloud-port.ts`](src/cloud-port.ts), [`src/hetzner-cloud.ts`](src/hetzner-cloud.ts): one cloud behind a small port. Create and delete through Alchemy; find, list and orphan removal straight to the API.
- [`src/capacity-provider.ts`](src/capacity-provider.ts): `createCapacityProvider`, the `CapacityProvider` implementation. Deterministic node ids, smallest-fit sizing from approved classes, a node ceiling, single-flight per request, ready only after enrollment, and deletes only machines carrying this Platform's labels.

The Platform controller validates policy, seals provider tokens, audits their use and gates scale-out on consent, sustained demand, caps and cooldown. `platform/cloud-engine.ts` derives the state-sealing key from the Platform master secret and claims a conditional cloud-authority epoch. It supplies a real single-use enrollment token to [`src/first-boot.ts`](src/first-boot.ts), which generates the worker installer/join script. Bundle and Platform-composition tests exercise this against the fake API, including enrollment.

## Remaining qualification

Real cloud creation, cloud-init, pinned enrollment, Fabric health/readiness and drain/fence/release have not been qualified together. The fake API does not prove provider rate limits, eventual consistency, real failure shapes or a Linux boot without a compiler. Worker install/join/doctor, public trust refresh and the enrollment listener exist; see `.agents/references/node-enrollment-design.md` for their contract and limits. Dashboard-driven worker updates, provider detection/adoption conveniences and the optional local deploy tool remain separate work.

`alchemy` is a dev dependency: it is bundled at build time and never shipped as a dependency. Pin it exactly and re-verify the scenarios on every bump.

The conditional cloud/state epochs do not prove cancellation of an in-flight cloud call or implement a distributed Fabric lease. Recipe-declared external resources need their own checkpointed deletion participant before they are introduced. Values Alchemy does not mark `Redacted` are stored as given; the secret codec does not seal every string.
