# Node enrollment: implemented contract and remaining qualification

Owner decisions approved 2026-10-06; status audited against `dev` on 2026-10-19.
Enrollment authority, live node registry/dispatch, HTTP/SDK/CLI operations,
worker install/join/doctor, pinned HTTPS enrollment listener, trust refresh,
bounded audit and cloud first-boot generation are implemented. Worker lifecycle
qualification runs in `release:check`. Booting a real cloud machine through the
whole path remains unqualified. This reference replaces the initial build plan;
public usage is in `../../website/src/content/docs/architecture/node-enrollment.md`.

## Authority and threat model

Enrolling authorizes a machine to receive Project snapshots and workloads.
Only the Platform may issue that authority. A machine supplied by a user uses
the same protocol as one created by a provider; no cloud account is required.

- The credential contains 256 random bits, is bound to a node id, expires and
  is single-use. The enrollment authority stores only its SHA-256 hash. Defaults are 15 minutes for a
  cloud enrollment and one hour for an operator enrollment.
- The authority consumes the token with System Store compare-and-set before
  registration. A retry with the same certificate inside the expiry may finish
  a half-completed enrollment; another certificate is refused. Revocation
  leaves a tombstone. Concurrent attempts cannot enroll different identities.
- The worker generates its own TLS key and self-signed certificate locally.
  The private key never leaves the machine. The Platform pins that leaf;
  changing its identity requires deliberate re-enrollment.
- The worker authenticates HTTPS before sending any request bytes, using
  ordinary verification, a named private CA, or an explicit fingerprint.
  Plain HTTP and redirects are refused. Do not use `rejectUnauthorized: false`
  plus `checkServerIdentity` as a pin: Node can ignore that callback's refusal.
  Check the secured socket before creating the HTTP request.
- Cloud `user_data` is readable by the cloud account and machine. It carries
  only a short-lived per-machine token, node id, enrollment URL and public
  fingerprint; never a provider token or durable private key. Generated shell
  values are strictly validated before quoting.
- The authority supports direct source-address checks, but HTTP enrollment
  does not apply one: the route has no trusted peer address. Never substitute
  a caller-controlled forwarded header.

## Implemented surfaces and readiness

Paths are relative to `/runtime`; SDK `client.nodes` and `zelavis nodes` expose
the same operations and permission checks.

| Capability | HTTP | Authority |
|---|---|---|
| List nodes and pending enrollments | `GET /nodes` | `server.nodes.view`, system scope |
| Read enrollment URL/fingerprint | `GET /nodes/platform` | `server.nodes.view`, system scope |
| Issue a credential | `POST /nodes/enrollments` | `server.nodes.enroll`, system scope |
| Join | `POST /nodes/enroll` | Single-use credential, no session |
| Refresh public trust keys | `POST /nodes/trust` | Public keys over the authenticated connection |
| Read attempt audit | `GET /nodes/audit` | `server.nodes.manage`, system scope |
| Revoke a node | `DELETE /nodes/:id` | `server.nodes.manage`, system scope; refuses active placements |

Issuing/joining is enabled only after the host publishes Platform public trust
keys; otherwise it answers `409 nodes-disabled`. Dispatch and Fabric inventory
read the registry live. Explicitly configured destinations win over enrolled
entries with the same id; enrollment cannot replace the local node. Fabric
probes the registered Agent before reporting it ready for workloads.

`zelavis serve --enrollment-port` enables a narrow HTTPS listener in the
persistent host, publishes its URL/fingerprint and enables remote dispatch.
Its certificate permits enrollment by IP without a dashboard hostname. Only
the enrollment and public-trust POST paths reach the runtime; other paths are
refused. Bodies and connections are bounded. Host firewall access remains an
operator responsibility. Without this listener, explicitly configured remote
dispatch and a suitable HTTPS endpoint are needed.

`zelavis worker join --enrollment-token ...` is host-local. It keeps the
key/certificate on retry, writes trust and identity files, and writes Agent
configuration last. `install --role worker` creates a dedicated account and
service/path units. Writing configuration triggers the Agent without another
privileged step. The single installation receipt discriminates Platform and
worker roles, records ownership before effects and drives role-aware removal.
Existing accounts are never claimed for removal. `zelavis doctor` checks the
worker's receipt, release, ownership, join state, units and local listener;
it cannot prove the Platform can cross a firewall.

## Version, trust and audit behavior

- A joining worker reports its version. A newer worker is refused with
  `409 worker-newer` after credential verification without consuming the token.
  Older workers are accepted and labeled `behind`; equal versions are
  `current`. This is an enrollment check, not continuous verification after
  an in-place worker update.
- Workers save how they authenticated the Platform and refresh its public
  signing keys at Agent start and daily over that same authenticated connection.
  `zelavis worker refresh-trust` provides the host-local manual operation.
  Invalid or currently unusable keys never replace working trust. A changed
  pinned Platform certificate requires deliberate rejoining.
- Wrong/expired/replayed credentials yield the same opaque refusal; detailed
  reasons are operator-only audit. Enrollment and public-trust reads each have
  their own global limit of 120 attempts per minute. There is no per-node limit
  that an attacker could use to lock out a named node.
- Attempt audit records bounded metadata without tokens, certificates or
  addresses, with 500-entry and 30-day retention limits. An audit-write failure
  is logged but cannot undo an already consumed token. Cloud-operation audit
  is separate and must succeed before an external action.

## Code and qualification

Paths below are relative to `packages/zelavis` unless stated otherwise.

| Area | Implementation / evidence |
|---|---|
| Token/registry authority | `src/platform/node-enrollment.ts`; `test/node-enrollment.test.mjs` |
| Public parity, permissions, versions, audit | `src/platform/node-routes.ts`, `node-enrollment-audit.ts`, `src/sdk/fetch.ts`, `src/cli/nodes.ts`; `test/node-enrollment-api.test.mjs` |
| Live registry dispatch | `src/adapters/_remote-node-sources.ts`, `_project-dispatch-https.ts`; `test/project-dispatch-registry.test.mjs`, `node-adapter-remote-nodes.test.mjs` |
| Join, pinning and certificates | `src/cli/worker.ts`, `src/adapters/_pinned-fetch.ts`, `_agent-certificate.ts`; join, pinning and certificate tests |
| Listener and trust refresh | `src/adapters/_enrollment-listener.ts`, `_platform-tls.ts`, `_trust-refresh.ts`, `src/cli/agent.ts` |
| Install, doctor and removal | `src/core/runtime/worker-installation-plan.ts`, `src/cli/install/worker.ts`, `src/adapters/_node-worker-uninstaller.ts`; worker installation/doctor tests |
| Cloud first boot | `services/zelavis-cloud/src/first-boot.ts`, `src/platform/cloud-engine.ts`; cloud first-boot and engine tests |

`distribution/scripts/qualify-worker.sh` proves the real installer, accounts,
units/path activation, real pinned enrollment and ready inventory, worker
update/restart, wrong-pin refusal and complete removal in disposable Debian
with systemd. Root `release:check` includes it as `distribution:qualify:worker`;
the full gate passed on 2026-10-19. This does not prove uninterrupted remote
workloads across Agent replacement.

## Remaining limits

- Qualify real provider creation → first boot → enrollment → health/readiness
  with a disposable cloud machine. Fake-API and worker gates cover the parts,
  not that external end-to-end behavior.
- Worker updates still require running the installer on the worker; the
  dashboard does not update it. Remote Agent handover and post-update version
  revalidation remain separate work.
- Direct peer binding is not wired, firewall reachability is external, and
  revocation scans Project placements rather than using a fleet-scale index.
- Token expiry before cloud first boot needs a tested replacement policy.
  A fresh enrollment cannot be assumed to rewrite an existing VM's `user_data`;
  replacement must use a distinct request/attempt identity.
