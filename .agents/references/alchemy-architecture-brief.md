# Cloud capacity and Alchemy: architecture and qualification

Owner decision: 2026-10-06. Status audited against `dev` on 2026-10-19:
**provider, fenced state, headless bundle, Platform controller, first-boot
composition and dashboard controls exist; real-cloud operation is unqualified**.
This reference retains the architectural decisions and measured findings from
the spike, replacing its completed build checklist. `AGENTS.md` is canonical.

## Ownership and product direction

- Cloud capacity is a Platform capability over the existing `CapacityProvider`
  contract (`packages/zelavis/src/core/provider/index.ts`). Fabric owns allocation,
  placement, draining and fencing. Alchemy supplies external machines/resources;
  its provisioning state is not Project, placement or data authority.
- Alchemy is the default engine inside the bundled first-party cloud service,
  not a dependency installed on a self-hoster's machine. Pin it exactly and own
  its bundle patch. If its behavioral tests fail, use a narrow adapter on the
  distilled clients rather than rebuilding a general infrastructure engine.
- Existing servers are the primary path. `install.sh` on the user's machine,
  or enrolling a worker with a one-time token, needs no provider. Provider
  adoption/firewall/DNS conveniences and automatic scale-out are additive.
  Never delete adopted or user-enrolled machines.
- An operator-side deploy tool using Alchemy through `npx` remains planned.
  Recipe-declared bounded external resources are also future work, with an
  explicit deletion participant; arbitrary recipe stack files are not executed.
  Neither belongs in local native App creation or Fabric reconciliation.

## Implemented components

Paths are relative to the repository root.

| Area | Implementation |
|---|---|
| Contract and machine ownership | `packages/zelavis/src/core/provider/index.ts`; `packages/zelavis/services/zelavis-cloud/src/capacity-provider.ts`, `capacity-naming.ts` |
| Cloud operations | Cloud service `src/cloud-port.ts`, `hetzner-cloud.ts`, `hetzner-capacity.ts`: Alchemy create/delete, direct API observation and orphan cleanup |
| Conditional provisioning state | Cloud service `src/provisioning-state.ts`: one System Store document per stack/stage, compare-and-set, owner epochs, required AES-GCM secret codec |
| Headless execution and bundle | Cloud service `src/alchemy-runner.ts`, `scripts/bundle.mjs`; only host-provided modules/built-ins are external |
| Platform connection, policy, authority and scaling | `packages/zelavis/src/platform/cloud-capacity.ts`, `cloud-engine.ts`, `cloud-routes.ts`; SDK `client.cloud`, CLI `zelavis cloud` |
| Enrollment and first boot | `packages/zelavis/src/platform/node-enrollment.ts`; cloud service `src/first-boot.ts`; `cloud-engine.ts` mints a token and supplies the script |
| Dashboard | `packages/zelavis/services/zelavis-ui/app/fabric-pages.ts`, `capacity.ts` |

The Node host composes the bundle when `ZELAVIS_CLOUD_POLICY` names an operator
policy and an enrollment endpoint is served. `cloud-engine.ts` validates
approved sizes/location/image/node ceiling, derives the provisioning secret key
from the Platform master secret and claims a System Store cloud-authority epoch.
A later process supersedes the old epoch. The provider checks current authority
and acquires its own conditional provisioning state; neither is permission for
an App to allocate or move itself.

Connections validate a provider token, seal it at rest and never return it.
Uses are audited before external actions; an unrecordable action does not run.
Scale-out requires separate consent, sustained shortfall, a machine cap and
cooldown. The wizard warns what the token can do and recommends a dedicated
cloud project. Price-based spend caps and provider detect/adopt conveniences
must not be inferred from these controls.

First-boot data invokes the ordinary installer with `--role worker`, then joins
as the worker account with a per-machine enrollment token and pinned Platform
fingerprint. Provider credentials do not enter `user_data`. See
[node enrollment](node-enrollment-design.md) for the implemented authority,
worker installer, trust refresh, listener and remaining limits.

The capacity provider reports `provisioning` until enrollment is recorded;
Fabric separately probes the enrolled Agent. Fake-API tests of that state
transition do not prove a real machine's boot, backend health or schedulability.
Release must follow Fabric's drain/fence authority, never a provider timeout
or an observation that a VM is running.

## Findings that must remain enforced

- **Use deterministic names from the capacity request id, plus ownership labels.**
  Alchemy's default physical name contains a random suffix stored only in its
  state. Losing that state produced a second server and orphaned the first in
  the fake. Explicit names let retry adopt the existing machine.
- Alchemy writes a `creating`/`deleting` intent before the cloud call. Conditional
  state and owner epochs fence superseded applies. Lost-response and
  create-before-result-save scenarios must stay idempotent. Keep state durable;
  deterministic names are recovery support, not a replacement for it.
- Alchemy's encoder serializes `Redacted` values in the clear. The state codec
  seals them with AES-256-GCM bound to the document; the codec is required at
  construction, before external effects. Values not marked `Redacted` are
  serialized as given: do not assume the codec seals every string.
- **Never compose Alchemy's own telemetry entrypoints or `Test/Core` helper.**
  The initial spike used that helper and likely sent telemetry. Shipped code
  and tests use `makeAlchemyRunner`, with telemetry excluded/opted out, an
  explicitly chosen `ALCHEMY_HOME`/working directory, and in-memory credentials
  rather than provider tokens in `process.env`. Preserve the network negative
  control proving the observer detects stray requests.
- Bundle all dependencies besides host-provided `zelavis`, `effect` and built-ins.
  The owned `import.meta.resolve` stub disables unused Alchemy local sidecars;
  re-verify that it applies and the bundle executes on every Alchemy bump.
  Never introduce a native runtime dependency or an install-script requirement.
  Retain required third-party notices when shipping the bundle.

## Measurements and qualification

The initial macOS spike on 2026-10-06 measured about **1.3 GB unbundled** versus
**824 KB** for a selected engine/Hetzner bundle (eight minified files). Adding
the headless Node layer later measured about **900 KB**. These are dated spike
measurements, not the current production bundle size or a size budget. The
initial imports loaded without native bindings or other clouds' clients.
The pinned Alchemy version is recorded in the cloud service manifest; do not
infer provider availability from a newer upstream version.

The local suites exercise a real Alchemy engine against a fake Hetzner API:
create/rerun/destroy, lost create response, crash before result-save, lost state,
deterministic adoption, foreign-machine refusal and owned orphan/key cleanup.
State suites cover concurrent CAS writes, superseded owner reads/writes/deletes,
bounded contention, corruption and sealed secrets. Provider tests cover approved
smallest-fit sizes, node ceilings, concurrent requests and enrollment gating.

`services/zelavis-cloud/test/bundle.test.mjs` (under `packages/zelavis`) executes
create/release through the built bundle and checks imports and the owned patch.
Its `first-boot.test.mjs` validates real installer/join flags and shell input
bounds. Root `packages/zelavis/test/cloud-engine.test.mjs` composes the bundle,
creates fake-cloud `user_data` with a real single-use Platform token and
completes that enrollment. `cloud-capacity.test.mjs`, `cloud-api.test.mjs` and
`cloud-scaling.test.mjs` cover encrypted/audited connection use, public parity,
policy, consent, sustained demand, ceilings and cooldown. Root verification
included these suites in the successful 2026-10-19 release gate.

These proofs replace the original claims that enrollment, first boot, the
controller or bundle execution were not built. They do not qualify real Hetzner
rate limits, eventual consistency, failure shapes, cloud-init or machine boot.

## Remaining work

- Run create → cloud-init → pinned enrollment → Fabric health/readiness →
  drain/fence → release against a disposable real Hetzner project, including
  crash/lost-response recovery and confirmation that no machine/key is orphaned.
- Qualify Linux execution without a compiler and the real network/telemetry
  boundary; fake API success and static import checks are narrower evidence.
- Prove promotion/revocation and credential handling against real provider
  calls. A conditional cloud/state epoch is not itself a distributed Fabric
  lease or proof that an already in-flight cloud call is canceled.
- Test expiry before first boot and replacement attempts; a new token cannot
  be assumed to alter the original VM's immutable `user_data`.
- Build the optional local deploy tool, provider detection/adoption conveniences
  and any additional providers separately. In the inspected pinned Alchemy
  package, DigitalOcean, Vultr and Linode had no provider.
- Before recipes can declare external resources, define checkpointed Project
  cleanup, shared-resource retention and explicit resource admission.
