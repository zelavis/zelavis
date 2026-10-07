# Node enrollment: design for review

Date: 2026-10-06
Status: decisions in section 6 approved by the owner on 2026-10-06 (all five recommendations). Steps 1a, 1b and 2 of section 7 are built; the rest is not. It is the missing piece between the cloud capacity provider (`packages/zelavis/services/zelavis-cloud`) and a machine that can receive Projects, and it also serves a user who brings their own server.

## 1. What exists today

A remote worker Agent is wired by hand, at startup, with no enrollment:

- **Platform side** (`packages/zelavis/src/adapters/node.ts`, around the `remoteDispatch` branch): `projectOptions.remoteDispatch.nodes` is a fixed map `{ nodeId: { url, agentId, caFile } }` read once at start. `createHttpsProjectDispatcher` signs Ed25519 authority for each destination and pins the destination's CA (`_project-dispatch-https.ts`, `Destination { url, caPem, agentId }`). Fabric's node inventory probes each destination's `/v1/health` (`probeProjectAgent`) and reports `ready` or `unavailable`.
- **Agent side** (`packages/zelavis/src/cli/agent.ts`): `zelavis agent --remote-project-config <file>` with `{ host, port, keyFile, certFile, trustFile, agentId, nodeId }`. The operator supplies the Agent's TLS key and certificate and the Platform's public trust keys.
- **Installer** (`distribution/installers/install.sh`): installs a Platform. There is no worker-only role, and no flag to join an existing Platform.

So today there is no runtime node registry, no way for a new machine to introduce itself, and no way to deliver the Platform's trust keys except copying a file.

## 2. What is missing

1. **A worker install mode**: `install.sh` (and the installed `zelavis install`) setting up only the remote Project Agent, as a separately supervised unit, with the usual uninstall inventory entries.
2. **A runtime node registry**: destinations persisted in the System Store (with Fabric inventory merging them with the static map), instead of read once from files.
3. **An enrollment protocol**: how a fresh machine proves it is the one intended, hands the Platform its TLS identity, and receives the Platform's trust keys.

The cloud service cannot finish "first-boot data and enrollment" without these. Until they exist, a first-boot script would name flags that do not exist.

## 3. Why this is security-critical

An enrolled Agent is sent Project snapshots when a Project is placed on it (`packRemoteProjectSnapshot`), which carry Project data and configuration. **The authority to enroll is the authority to receive customer workloads.** A leaked or guessable enrollment credential is therefore as serious as a leaked deploy key.

Specific exposures:

- **`user_data` is not secret.** Anyone with the cloud account can read it back through the API, and every process on the machine can read it from the metadata service. Whatever the first-boot script contains must be worthless after its first use.
- **The new machine must authenticate the Platform**, or a network attacker can feed it attacker trust keys and become the machine's Platform.
- **A crash can leave a half-enrolled node** (credential consumed, destination not registered).

## 4. Proposed protocol

**Credential: a single-use enrollment token.** 256 random bits. The Platform stores only its SHA-256 hash, with the node id it is bound to, an expiry (default 15 minutes for a cloud-created node, 1 hour for an operator-issued one) and a state of `unused`. Storage is one System Store record per node id (`fabric.node-enrollment.v1`), updated only by `compareAndSet`.

**Flow for a cloud-created node:**

1. The capacity provider asks the Platform for an enrollment for `nodeId` (the deterministic machine name) before it calls the cloud. The Platform mints the token and returns it once.
2. The provider puts into `user_data` only: the Platform's enrollment URL, the SHA-256 fingerprint of the Platform's TLS public key (public information), the node id and the token. Nothing durable.
3. On first boot the machine installs the worker role, generates its own TLS key pair and self-signed certificate locally (the private key never leaves the machine), and calls `POST /runtime/nodes/enroll` over HTTPS, **pinning the Platform's key fingerprint** from `user_data`.
4. The Platform checks the token (constant-time hash compare, not expired, unused, bound to this node id), then **consumes it with a `compareAndSet` to `consumed(certSha256)` before any effect**. Optionally it checks that the request's source address equals the address the cloud reports for that machine (defense in depth; may not hold behind NAT).
5. It registers the destination `{ url, caPem: <the Agent's certificate>, agentId }` in the node registry, and responds with `{ agentId, nodeId, platformTrust: { keys } }`.
6. The Platform probes the Agent's health (the existing probe, which verifies the TLS peer is the assigned Agent). Only then does Fabric report the node `ready`, and the capacity provider's `isEnrolled(nodeId)` becomes true.

**Crash safety.** If the token was consumed but registration did not complete, a repeat of the same enrollment (same `certSha256`) within the expiry returns the same response and completes registration. A different certificate is refused, so a stolen token cannot be replayed with a different identity after the real machine enrolled.

**Failure and recovery.** `user_data` cannot be changed after a machine is created. If the token expires before the machine enrolls, that machine cannot enroll. After an enrollment deadline Fabric marks the node `failed`, releases it, and a new request (new request id) creates a replacement. The deterministic-name rule means retrying the same request id would adopt the dead machine, so a replacement needs a new id (an attempt counter).

**Release.** Fabric drains and fences first, then the registry entry is revoked (tombstoned), then the cloud machine is deleted. A revoked node's certificate no longer matches any destination.

**Existing servers (the primary path).** `zelavis nodes enroll-token` (and the equivalent HTTP and SDK call) mints an operator-issued token and prints one command to run on the user's own machine, for example `curl https://zelavis.com/install.sh | sudo sh -s -- --role worker --enroll <url> --token <token> --platform-fingerprint <sha256>`. Same protocol, no cloud involved, and the token is shown once.

## 5. Public surface (parity rule)

All of these exist as HTTP, SDK and CLI together, with shared schemas and equivalent errors:

| Capability | HTTP | Access |
|---|---|---|
| Mint an enrollment | `POST /runtime/nodes/enrollments` | new `server.nodes.enroll`, system scope |
| Enroll (token-authenticated) | `POST /runtime/nodes/enroll` | the token; rate limited per source and globally; no session |
| List nodes | `GET /runtime/nodes` | `server.nodes.view` |
| Remove a node | `DELETE /runtime/nodes/:id` | `server.nodes.manage`; refuses a node with active placements |

The capacity controller calls the mint operation in-process, with the same checks.

## 6. Decisions (approved 2026-10-06: the recommendation in each case)

1. **Agent certificate model.** Pin the Agent's self-signed leaf certificate (simple; rotation means re-enrolling), or have the Platform issue certificates from a per-installation CA (revocation and rotation, but a CA whose private key becomes a new protected Platform secret). I recommend pinning the leaf first, with the registry shaped so a CA can replace it later.
2. **How the new machine authenticates the Platform.** Fingerprint pinning from `user_data` (works with any certificate, including the self-signed fallback) versus relying on a public certificate for the Platform hostname. I recommend the fingerprint, since a Platform can be reached by IP.
3. **Source-address binding.** Enforce it for cloud-created nodes only, or never (NAT and IPv6 make it unreliable)? I recommend enforcing it when the cloud reports a public address and the connection is direct, and logging otherwise.
4. **Token lifetime.** 15 minutes for cloud-created, 1 hour for operator-issued, as above. Longer is easier to operate and weaker if leaked.
5. **Whether an operator must approve each cloud-created node.** Automatic scale-out needs to be unattended, so I recommend no per-node approval, with the node cap and the cloud-side limits as the bound.

## 7. Build order

1. **Internal token authority and node registry** over the System Store (`compareAndSet` only). Split in two:
   - **1a, built:** `packages/zelavis/src/platform/node-enrollment.ts`, Effect-based, with 19 tests (`packages/zelavis/test/node-enrollment.test.mjs`). Mint a single-use token (hash only is stored; plaintext once), complete an enrollment (token consumed by `compareAndSet` before registration; the same certificate may finish a half-done enrollment; any other certificate is refused; one opaque `refused` code to callers with the reason kept for audit; source-address binding when the connection is direct; expiry; malformed input rejected before the token is consumed), the node registry (`destinations`, `nodes`, `revoke` leaving a tombstone), and bounded `prune`. The tests cross-check the certificate fingerprint against Node's `X509Certificate`.
   - **1b, built:** the dispatcher and Node host now see registered nodes without a restart. `createHttpsProjectDispatcher` takes an optional `resolveDestination` (the registry), consulted only when a node is not configured, so an operator's pinned node always wins; its four methods are now Effect programs. A new `adapters/_remote-node-sources.ts` loads the configured destinations and builds the registry lookup and the Fabric inventory (configured plus registered nodes, probed eight at a time, revoked nodes not listed); the local node id can never be taken over through the registry. `async resolve` in `adapters/node.ts` was converted to Effect (about a dozen awaits and one retry loop; its nested closures are untouched), which removed 11 entries from the Effect-migration baseline (981 to 970) via the repo's own prune command, with no new entries. Tests: `project-dispatch-registry.test.mjs` (5), `node-adapter-remote-nodes.test.mjs` (6, through the real adapter and System Store, including a real remote Agent over pinned TLS that becomes `ready` through the registry while the same endpoint registered under another node id stays `unavailable`), plus the 19 existing dispatch and remote-Agent tests, unchanged and green. Not covered by any test: the host-operations connection retry loop (it needs a supervised Agent), which was converted mechanically.
2. **Enrollment endpoint, SDK and CLI, built** (`platform/node-routes.ts`, `client.nodes` in `sdk/fetch.ts`, `cli/nodes.ts`; public docs in `website/.../architecture/node-enrollment.md`). `GET /runtime/nodes`, `POST /runtime/nodes/enrollments`, `POST /runtime/nodes/enroll` (no session; the token is the credential), `DELETE /runtime/nodes/:id`. 10 parity tests in `node-enrollment-api.test.mjs` run the same flow and the same failures through raw HTTP, the SDK and the CLI and compare results, status codes and messages; plus access (anonymous, unprivileged, and each of `server.nodes.view|enroll|manage` alone), the disabled state, the placement guard on remove, the attempt limit, and that the host publishes only public keys. Decisions made while building:
   - **Enrollment is on exactly when the Platform has published its public trust keys**, which the host does where remote dispatch is configured (`fabric.agent-trust.v1`). Without them a credential could be issued that no machine could use, so issuing and enrolling answer `409 nodes-disabled`. This avoided threading a new parameter through the large endpoint-group function.
   - **Every refusal is one `403 Enrollment refused.`** (tested identical across wrong token, unknown node and a flipped token); reasons stay in the authority for audit.
   - **Source-address binding is not applied.** The route context has no peer address, and `X-Forwarded-For` is caller-controlled, so honoring it would be a spoofable check. The authority still supports it; wiring needs a host that exposes the direct peer.
   - **The attempt limit is global (120 a minute), not per node.** Tokens are 256-bit, so a limit protects resources, not secrecy; a per-node limit would let anyone lock a known node id (they are deterministic) out of enrolling.
   - **Remove refuses while any Project is placed on the node** (active records in `fabric.project-ownership.v1`) and leaves a tombstone. That scan reads every placement; fine now, needs an index at fleet scale.
   - The CLI's enrollment credential flag is `--enrollment-token`, because `--token` is already the API bearer token on every command.

   Open from this step: **trust-key refresh** (Platform keys last 365 days and rotate 30 days before expiry, so a trust file delivered once at enrollment goes stale; the hand-made trust file has the same property), an **audit trail** for refused enrollments (the reasons are produced, nothing records them), and **enabling remote dispatch by default** so enrolled nodes are usable on a standard installation (until then an operator must configure `projects.remoteDispatch`, which may have an empty `nodes` map).
3. **Worker install mode** in the installer and `zelavis install`, with the uninstall inventory, isolated destructive-path tests and docs updated in the same change (AGENTS.md requires this whenever the installer owns another resource), and qualification in a disposable Debian/systemd container.
4. **First-boot data in `@zelavis/cloud`**: build the `user_data` script from the real, existing flags.
5. **Real-cloud qualification** of the whole path.

Not before step 3: any first-boot script, because it would name flags that do not exist.
