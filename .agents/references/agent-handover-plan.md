# Project Agent handover: implemented contract and qualification

Status: **released in `2.0.0-alpha.40`; Linux system-installation qualification
passed on 2026-10-19**. The historical filename is retained
because `AGENTS.md` and the core-platform skill link here. This is the current
reference, not an implementation task list. Release procedure belongs in
`../skills/zelavis-release-maintainer/SKILL.md`; public behavior is documented in
`../../website/src/content/docs/architecture/updates.md`.

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
30-second commit deadline. Managed private runtimes are warmed before admission
resumes. Preview listeners retain accepted sockets across temporary stopped
snapshots; health/config/update/debug reads remain available during recovery.

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
  separately before extending the continuity claim. No live VPS continuity
  claim follows from the local gates.
- Remove the explicit pre-protocol conversion when no supported installation
  needs it, preserving deliberate coverage of historical update paths.

The independent website allow-list repair deployed sequence 15. The old
sequence 12 affected marketplace freshness; it was not the cause of the Agent
failures reproduced in these gates.
