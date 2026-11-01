# Project Agent handover: implemented contract and qualification

Status: **corrected in `2.0.0-alpha.41`; Linux installed qualification and a live
VPS update passed on 2026-10-19**. The historical filename is retained
because `AGENTS.md` and the core-platform skill link here. This is the current
reference, not an implementation task list. Release procedure belongs in
`../skills/zelavis-release-maintainer/SKILL.md`; public behavior is documented in
`../../website/src/content/docs/architecture/updates.md`.

**Production correction, 2026-10-19:** alpha.40's conversion failure could close
the entire Platform request gate indefinitely, including its repair APIs and
all Project previews. Successful installed qualification missed this fault.
The correction is published and verified on the owner's VPS. See the
incident findings below before relying on the earlier qualification claims.

## Purpose and scope

Previously, Update now replaced the Platform and root operations Agent but left
the Project Agent running its original release. Restarting that Agent stopped
its pipe-connected Project processes. The implementation updates the Linux
system Project Agent while preserving already-survivable Project processes.
An Agent predating the protocol needs one explicit conversion restart of its
Projects, with admission held until recovery. Never describe that first update
as preserving Project processes.

Qualification covers local Linux Node system installations. Remote-worker and
Bun Agent replacement, and multi-host partition recovery, remain unqualified.
User-mode embedded Agents receive new code when their persistent host next
starts. Worker install/update qualification is separate and does not establish
survivable remote-worker replacement.

## Implemented contract

- The production daemon opts into `_agent-survivable-process-runner.ts`.
  Processes run in their own groups with private append-file output and stable
  UUIDs. An exec gate flushes the validated process record before activation.
  Bare executable names resolve through the command's supplied PATH; an absent
  PATH cannot fall back to the Agent environment. Records and logs must not
  contain environment secrets or Gateway credentials.
- Identity uses the Linux boot UUID and `/proc` start ticks. Kernel locks
  exclude concurrent runner and endpoint owners before recovery or socket
  mutation. Elapsed process age is not sufficient proof of identity.
  Adoption revalidates placement leases; recovery never grants new placement
  authority. Stop intents retain exact descendant identities before signaling,
  including escalation after the group leader has exited.
- Output and replay are bounded. Log inode checks refuse replacement or unsafe
  paths. Files are truncated in place at the configured cap (currently 8 MiB
  per stream); output around truncation can be lost. An adopted process is no
  longer the new Agent's child, so its final exit code may be unknown. There is
  no persistent per-child holder process.
- Native App and managed integration hosts use authenticated private socket
  control with key rotation, command deduplication, bounded deadlines and
  capacity. Control no longer depends on the old Agent's stdin pipe.
  Deliberately interactive piped sessions remain disposable.
- The IPC client preserves handles through bounded transport loss and rebinds
  by UUID. Disconnect alone is not process exit. Stop during a gap waits for
  reconnection; exhaustion reports failure. Never replay an ambiguous process
  start or operation submission.
- `agent.json` identifies the running Agent. A handover marker is bound to its
  generation, boot and expiry, and consumed once. A valid marker permits
  survivable children to remain; markerless shutdown stops workloads. Uninstall
  additionally kills remaining members of the owned unit cgroup.
- Project units use `KillMode=process`, `TimeoutStopSec=95`, no delegated
  operation controllers and no `PrivateTmp`. The separate root operations
  Agent retains its cgroup containment. The delegated-controller layout failed
  replacement with systemd `219/CGROUP` in the primitive negative control.
- Agent failure is recorded as degradation separately from the selected
  healthy Platform engine. It must not roll back that committed engine or
  silently report the Agent current.

## First conversion and installed-update findings

Pre-protocol conversion is two-phase. The candidate engine prepares private
admission holds while its persistent host is drained, then acknowledges root
inventory. Agent replacement and Project recovery follow outside older hosts'
30-second commit deadline. Public workloads must resume before managed private
runtimes finish warming. Preview listeners retain accepted sockets across
temporary stopped snapshots; management and repair remain available throughout.

The alpha.40 implementation violated that contract: a private integration
startup/recovery timeout closed the shared conversion gate forever, and a small
GET allow-list left dashboard, login, logs, nested Project diagnostics and repair
behind that gate. Live inspection confirmed all three Project previews returned
the same 503 even though their workload processes were running. A same-release
Platform engine reload through the existing authenticated local host control
recovered the dashboard, WordPress and DokuWiki without changing their process
PIDs or kernel birth ticks. The native App API also recovered; its public root
reported its existing no-frontend placeholder. This is a recovery proof, not
evidence that the original update preserved availability.

The correction limits the conversion gate to Project traffic and lifecycle
mutations, releases public traffic before private integration warmup, and releases
the coordination hold on recovery failure or deadline. It preserves ordinary
Project ownership and readiness checks. Pre-existing failed Projects do not
become fleet-wide readiness conditions. Recovery bounds cover reconciliation
and integration calls; a nonce-bound watchdog cannot expire a later conversion.
The outer Project host startup deadline is 90 seconds rather than 15, allowing
its inner supervisor's 30-second stages. Deterministic clock tests cover slow
readiness, startup cleanup, stalled recovery and coordination expiry; a real
Platform test covers dashboard, authentication, status, logs and nested diagnostics
during a conversion hold. The private work record contains the live timeline;
completed release and VPS verification are recorded below.

The same correction preserves lazy backend startup during conversion: only a
previously used managed integration with an existing regular host journal is
warmed independently with concurrency two and a separate 90-second budget each.
Agent conversion completes after public recovery; private warmup does not extend
or fail that Agent transaction. This hint grants no
execution authority; the ordinary manager still verifies the recipe, journal,
placement and ownership. Private startup failures are retained in the runtime
log and merged boundedly into the owning Project's logs with an integration
label. Process diagnostics associate path-ending Project hosts and their engine
children with that Project, including private integration hosts.

Additional qualification caught a remaining defect after the first correction's
main gate passed: direct alpha.39 conversion on 2 CPUs / 4 GiB exhausted the
updater's 75-second report window while private warmup shared the engine's
90-second recovery window. The final design separates private restoration as
above and derives the updater's longer reporting/total budgets from the same
public recovery constant. `release:check` now requires the direct alpha.39
conversion in addition to the actual previous npm release. Both installed gates
run on a fixed 2-CPU / 4-GiB budget, rather than borrowing the owner's whole Mac.

Complete installed qualification found two defects that primitive PID proofs
missed:

1. MariaDB could not create temporary tables after the full update/restart
   sequence when its temporary storage depended on the Agent-private namespace.
   Omitting `PrivateTmp` makes the full sequence pass. A plain PrivateTmp restart
   did not reproduce the failure, so it does not prove the entire cleanup
   mechanism. Always test database writes after the full sequence.
2. Historical recipes contain bare executable names; direct execve did not
   search PATH. The exec gate now resolves only the command's supplied PATH,
   with production regression coverage for success and refused fallback.

Non-secret workload/Project labels distinguish legitimate native hosts and
workers in diagnostics. Short private socket names avoid macOS path limits.
Neither diagnostic labels nor observed PIDs are authority.

## Code and behavioral evidence

Paths below are relative to the repository root.

| Area | Implementation / evidence |
|---|---|
| Durable spawn and recovery | `packages/zelavis/src/adapters/_agent-survivable-process-runner.ts`, `_agent-process-launcher.ts`, `_agent-endpoint-lock.ts`; `packages/zelavis/test/agent-survivable-runner.test.mjs` |
| Daemon and reconnecting client | `packages/zelavis/src/cli/agent.ts`, `src/adapters/_agent-lifecycle.ts`, `_agent-ipc.ts`; Linux production and IPC tests |
| Private host control | `packages/zelavis/src/adapters/_agent-engine-control.ts`, `_node-project-control.ts`, `_node-project-runtime.ts`; App-host recovery and installed integration tests |
| Conversion and installed lifecycle | `packages/zelavis/src/adapters/_agent-update.ts`, `_node-updates.ts`, `src/core/runtime/installation-plan.ts`, `installation-health.ts`; `agent-conversion-control.test.mjs`, installation and removal tests |
| Unit restart/crash primitives | `distribution/scripts/qualify-agent-survival.sh`, `agent-survival-host.sh`: PID/start-tick/output/temp-file continuity, limits and delegated-controller negative control |
| Updates and historical Projects | `distribution/scripts/qualify-installed-update.mjs`, `qualify-history*.{mjs,sh}`, `distribution/history.json`: traffic, engine selection, data writes, recipe upgrades, restart, doctor and removal |

The full root `release:check` passed on clean commit
`bc12f121d41fd6d5e647a8e1d5f877f18e1b3d70`: 2,140 Platform tests passed,
31 platform-specific tests skipped; workspace builds/typechecks/tests, browser,
docs, allow-list and repository/distribution checks passed, followed by the
systemd primitive, all 20 Linux Agent tests, installed update, long history and
worker enrollment/update/removal gates. This qualifies that source commit;
versioning a release creates a new commit that must be qualified again.

The actual alpha.40 release then passed the full gate on clean commit
`88c4614e7fb5c603e4aff44204926c18a0c0124d`: 2,141 Platform tests passed,
31 platform-specific skips, the complete browser suites and every installed
qualification gate green. History recipe upgrades served 506 WordPress and
430 DokuWiki responses without failure. npm metadata, alpha tags and downloaded
tarballs for the Platform and four bundled packages matched the publisher's
packed digests. The release log is `/tmp/zelavis-alpha40-release-check.log`.

The corrected alpha.41 passed the full gate on clean commit
`1eb013ea3dbfa32c7a5097ca0152d32573249903`: 2,152 Platform tests passed,
31 skipped, complete browser suites and all installed gates green. Both the
actual npm alpha.40 update and direct alpha.39 conversion ran on 2 CPUs / 4 GiB;
the latter completed its update in 58,110ms. History recipe upgrades answered
1,047 WordPress and 605 DokuWiki requests without failure. The authoritative
log is `/tmp/zelavis-alpha41-release-check.log`. All five published npm tarballs,
registry integrities and alpha tags matched the publisher's digests.

The owner's live Linux VPS then updated through the ordinary authenticated API
from alpha.40 to alpha.41 in 54,751ms. Platform and Agent both report alpha.41.
WordPress's database/PHP/web processes, DokuWiki's PHP/web processes, the native
App host and worker, the persistent Platform host and Traefik retained their
PIDs and kernel start ticks. Project recipe locks, preview ports and runtime
start times remained unchanged; the native App retained its alpha.36 engine pin.
Both managed private runtimes and the native App answered their runtime config
APIs with 200. Across the update and private cold starts, 675 HTTP checks matched
the expected dashboard/site responses and native App no-frontend placeholder,
with zero unexpected failures; the longest observed request was 5,077ms. This
proves continuity for this update, not absence of downtime in the earlier incident
or exhaustive application-data integrity. Local proofs are
`/tmp/zelavis-alpha41-vps-update-proof.json` and
`/tmp/zelavis-alpha41-vps-http-proof.json`.

Linux production tests cover repeated App handover/crash and re-key,
lost-start adoption, markerless/stale-marker stop, stop during disconnect,
log replay/truncation and inode replacement, PID reuse, locks, leader-first
escalation, private stdin fencing, expired placement, reconnect exhaustion,
transient EIO backoff, PATH resolution and a real plan controller (seed
3737844653). Private-control tests cover authentication, deduplication,
deadlines and full-cache refusal.

Installed alpha.39 → disposable alpha.40 → alpha.41 qualification proves the
one-time conversion, then unchanged supervised PIDs and kernel birth ticks
across forward Agent replacement, matching diagnostics without duplicates,
Platform rollback/reselection, App selection both ways with retained data,
WordPress integration upgrade, post-restart login and database writes, healthy
doctor and complete uninstall. An isolated run served 24,558 HTTP requests
without failure. History qualification carries alpha.25 WordPress and alpha.29
DokuWiki through alpha.39 onto the candidate, upgrades their exact recipes
under traffic and restarts with one process per service (529 + 426 responses
in the full gate, zero failures; isolated run 729 + 455).

Local evidence was recorded in `/tmp/zelavis-agent-release-check.log`,
`/tmp/zelavis-agent-update-proof.json`,
`/tmp/zelavis-agent-update-temp-candidate.log` and
`/tmp/zelavis-agent-history-final.log`. These are ephemeral local logs, not
portable dependencies. The maintained private work record is `pnotes/TODO.md`.

## Remaining qualification and maintenance

- Future releases must version and qualify their actual commit before npm publication. The
  temporary candidate versions alter disposable payloads, not the checkout or
  npm. Use `ZELAVIS_FUZOR=npm pnpm release:check` from the root, with no concurrent
  build in this checkout.
- The Fuzor 0.5.1 standalone Node adapter's aborted-stream failure recurred
  during alpha.40 qualification. The isolated server-view fixture now uses
  Zelavis's production HTTP boundary and dashboard asset loader, retaining
  every browser assertion. Installed Zelavis already uses that boundary;
  the external Fuzor fix remains unpublished. Alpha.40 qualification also fixed
  a secret-test command missing `--` before a potentially leading-dash secret,
  with a deterministic case sharing the same test body. Neither fix changes
  production runtime behavior.
- Qualify remote-worker/Bun replacement and multi-host partition recovery
  separately before extending the continuity claim. The live proof above covers
  one local Linux Node installation and does not qualify those other paths.
- Remove the explicit pre-protocol conversion when no supported installation
  needs it, preserving deliberate coverage of historical update paths.

The independent website allow-list repair deployed sequence 15. The old
sequence 12 affected marketplace freshness; it was not the cause of the Agent
failures reproduced in these gates.
