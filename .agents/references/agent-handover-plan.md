# Project Agent handover: updating the Agent without restarting Projects

Status: **plan, not implemented** (written 2026-10-18). Owner decision: when Zelavis updates to the
latest release, the Project Agent must really be on the latest release too, and customer Projects must
keep serving while that happens ("option 2", the real handover, not a restart).

This document is written for an agent that has not seen the conversation behind it. Read it top to
bottom, then read the files named in "Where the code is". Verify every claim about current behaviour
against the code before relying on it; line numbers drift.

## 0. How much to trust this plan

It was written by reading the code, not by building or running any of it. Nothing below has been
tested. Treat the design as a well-reasoned hypothesis and prove it step by step (section 5 orders the
work so the riskiest unknowns are tested first). The two largest unknowns:

1. **systemd behaviour.** Whether `KillMode=process` with `Delegate=yes` and the Agent's own cgroup
   layout really leaves children running across `systemctl restart`, without systemd marking the unit
   failed or killing stragglers later. This must be proved in the Docker systemd gate, not by reasoning
   (sections 4.3E and 9).
2. **Who relies on "a closed connection means the process exited".** The current client settles every
   process as exited when the socket closes. The reconnecting client changes that for all users of the
   client (Platform drivers, remote environment sessions, dev-mode Agent). Find every user before
   changing it (section 9, question 1).

One consequence is certain regardless of the unknowns: an installation whose Agent predates this
change (the owner's VPS runs alpha.27) cannot hand over, so the first update that carries the new Agent
restarts its Projects once (section 7). Say so in the release notes and the dashboard when it happens.

Do the riskiest proofs first: a throwaway test that starts real child processes with file-based output,
kills the "Agent", and has a second runner adopt them (step 1), and a Docker/systemd check that a
`KillMode=process` unit restart leaves children alive (before step 4), before building the rest on top.

## 1. The problem, with evidence

There are two helper programs next to the Platform on a system installation:

| Unit | User | Runs | Restarted by Update now? |
|---|---|---|---|
| `zelavis-agent.service` ("Project Agent") | `zelavis` | every Project process (`php-fpm`, `caddy`, `mariadbd`, Node runtimes) as its children, plus Project placement lease supervision | **No** |
| `zelavis-host-agent.service` ("host Agent") | `root` | fixed, signed host operations (package install, Edge, PHP builds) | Yes (`host-agent-restart` step) |

The Project Agent is deliberately a separate service so Projects survive a Platform restart or engine
handover. But its unit has `KillMode=control-group` (`distribution/runtime/zelavis-agent.service`), so
restarting the unit kills every Project. The updater therefore never restarts it, and it keeps
running the release it was started from (its `ExecStart` resolves `/opt/zelavis/current/bin/zelavis`
once, at start).

Observed on the owner's VPS (2026-10-18), read through the new `GET /runtime/debug/processes`:

```
326427  parent 1       2026-10-14  .../releases/2.0.0-alpha.27/.../cli.js agent --operations-root ...
326598  parent 326427  .../releases/2.0.0-alpha.27/.../_node-project-runner.js
685819  parent 326427  php-fpm: master process (.../projects/locus/...)
685822  parent 326427  caddy run --config .../projects/locus/.../Caddyfile
```

The Platform was on alpha.39 while the Agent that owns every Project process was still alpha.27, four
days and twelve releases old. Consequences: any Agent-side fix or feature never reaches an existing
server through Update now; the Platform must keep talking to an old Agent over an unversioned protocol;
`AGENTS.md` requires every release to be installable through Update now, and this is a gap in that.

Goal: after Update now, the Project Agent runs the same release as the Platform, **with no Project
process restarted**, rollback preserved, and qualified by the release gates.

## 2. Hard constraints (from AGENTS.md; re-read the relevant sections)

- Zelavis is pre-release: **no compatibility shims, aliases or fallbacks for old shapes.** The one
  exception is unavoidable one-time conversion of installations whose Agent predates this protocol
  (section 7); keep it a single, explicit, tested path and name it in the docs as a known gap, never
  as precedent.
- **Effect v4** for new asynchronous orchestration (`Effect.fn`/`Effect.gen`, typed failures via
  `Data.TaggedError`, never the global `Error` in an Effect failure channel (strict language-service
  warnings fail `pnpm run verify`), bounded concurrency, scoped cleanup). `pnpm check:effect-usage` and
  `pnpm check:tigerstyle` run in `verify` and have no baseline; do not add Promise orchestration, silent
  catches, unchecked `JSON.parse` casts or unbounded concurrency.
- TigerStyle: define authority, invariants, resource limits and interruption/recovery behaviour before
  coding. Fencing and recovery need failure-path tests, not only happy paths.
- JS SDK, HTTP and CLI parity for anything public (this work is mostly internal; if a status surface is
  added, do all three).
- No separate worktree folders, no extra directories outside the repo. Work on `dev`.
- Distribution trust model: no signing keys, no CI secrets, no GitHub Actions/Releases. A release is
  `npm publish` by the owner (login and 2FA are the owner's, never yours).
- `pnotes/TODO.md` (separate private repo, `pnotes/`) must be updated in the same change: mark done what
  is done, add every new open item as found. Update `AGENTS.md`, `website/src/content/docs/architecture/updates.md`
  and the uninstall inventory (section 8) in the same change.
- Verify from the repository root: `pnpm run verify`; browser suites `pnpm run ci:ui`; docs
  `pnpm run docs:check`; release gates `pnpm run release:check` (about 30 minutes, needs Docker). Never
  declare done without the Docker update and history gates passing.

## 3. Where the code is (read these first)

| File | Why |
|---|---|
| `packages/zelavis/src/adapters/_agent-process-runner.ts` | The local runner: `spawn` with `stdio` pipes, `registerChild` (SIGTERM children on process exit), `ProcessRecord` JSON files in `<data>/projects/.agent-processes`, `reclaim()` (kills leftovers of a dead owner), `fencePlacement`, `processAgeMs`/`isAlive` pid-reuse checks. `survivesControlPlaneRestart: false`, no `attach`. |
| `packages/zelavis/src/adapters/_agent-ipc.ts` | Server (the Agent daemon): `processes` map, counter ids `p1, p2...`, replay buffer (500 lines), placement lease supervisors, `attach` (hands out entries that have no live socket), `reclaim`, `stop`, `signal`, `write`, `fence.placement`. Client (`createAgentProcessClientProgram`): on socket close `abandon()` settles **every** process listener with `{code: null, signal: null, requested: false}` (this would look like a crash to the controllers) and the client never reconnects. |
| `packages/zelavis/src/cli/agent.ts` | `zelavis agent`: builds the runner with `stateDirectory: <data>/projects/.agent-processes`, calls `runner.reclaim()` at start, on SIGINT/SIGTERM closes the server, which stops all owned processes. |
| `packages/zelavis/src/core/agent/process-command.ts` | The runner contract: `ZelavisAgentProcessRunner`, `ZelavisAgentProcess`, `ZelavisAgentAttachedProcess`. |
| `packages/zelavis/src/core/recipe/plan-controller.ts` | Per-Project plan controller: `adopt()` takes back attached processes, treats a process `exit` as a crash event; `reclaim` hook (added in alpha.39) stops uncontrolled identical-command leftovers before a start. |
| `packages/zelavis/src/adapters/_recipe-project-runtime.ts` (`adopt`), `packages/zelavis/src/adapters/_node-platform-engine.ts` (`qualify`) | How a new Platform engine adopts Projects at handover. |
| `distribution/runtime/zelavis-agent.service`, `distribution/runtime/zelavis-agent@.service` | The unit (`KillMode=control-group`, `Delegate=yes`, `Restart=on-failure`). |
| `packages/zelavis/src/core/runtime/installation-plan.ts` | Ordered install plan: `UNITS`, `agent-enable`, `host-agent-restart`. The Project Agent is enabled but never restarted. |
| `packages/zelavis/src/adapters/_update-runner.ts`, `_node-updates.ts` | The root updater: prepare (`--stage-only`), then `install --from-release --live`, health check, rollback. |
| `website/src/content/docs/architecture/updates.md` | Public description of handover; "Project and visitor continuity" must be extended. |
| `distribution/scripts/qualify-installed-update.mjs`, `qualify-history*.{mjs,sh}`, `distribution/history.json` | The Docker/systemd release gates to extend. |
| `packages/zelavis/src/adapters/_remote-project-agent.ts` | Remote worker Agents: check whether they share the runner and must follow the same rules. |

## 4. Design

### 4.1 Idea

Make the **Agent replaceable under live children**, in three layers:

1. **Processes survive the Agent.** Project processes are no longer attached to the Agent by pipes. They
   write their output to append-only log files, run in their own process group, and their identity is a
   durable record. A new Agent finds them by their records and takes over supervision.
2. **A new Agent adopts survivors** instead of killing them at start.
3. **The Platform's Agent client reconnects and rebinds** its process handles to the new Agent
   transparently, so a dropped connection is not a process exit.

Then "update the Agent" is just `systemctl restart zelavis-agent.service` with a handover marker, done
by the root updater, with no coordination with the Platform engine.

### 4.2 Why this shape (alternatives considered and rejected)

- **One small Node "holder" process per child** (a conmon-like shim that is the child's parent and
  serves a control socket): robust, gives exit codes, but each holder costs tens of MB of RSS and a
  WordPress Project already has three processes. Rejected on cost; revisit only if exit codes become
  important.
- **Passing pipe file descriptors from the old Agent to the new one:** Node can only pass
  `net.Socket`/server handles over child IPC, and exit statuses (`waitpid`) cannot be transferred.
  Fragile. Rejected.
- **Engine-coordinated restart inside the Platform handover window:** couples the Agent update to the
  engine handover, breaks on rollback, needs a new interlude protocol in the host. Rejected; the
  reconnecting client makes it unnecessary and also fixes Agent crashes.
- **Option 1 (restart the Agent, hold requests at the ingress, restart Projects):** brief
  interruption per Project. Only kept as the one-time conversion path (section 7).

### 4.3 Components

**A. Survivable runner mode** (`_agent-process-runner.ts`, used only by the `zelavis agent` daemon;
the in-process runner used in dev stays as is).

- Spawn with `detached: true` (own process group) and `stdio: ["ignore", fdOut, fdErr]` where the fds are
  files opened `O_APPEND` under `<data>/projects/.agent-processes/<processId>.out` and `.err` (mode 0600,
  directory 0700). No pipes: when the Agent exits, the child must not get SIGPIPE on its next write.
- Do **not** call `registerChild`'s "SIGTERM on exit" for survivable children; that hook is what kills
  children when the Agent process exits today.
- `stdin: "pipe"` processes (remote environment sessions) are **not survivable**: keep the existing pipe
  behaviour for them and mark them `survivable: false` in the record; they are stopped on handover and
  recreated by their owner. Project processes use `stdin: "ignore"`.
- Extend `ProcessRecord` (JSON, validated with `objectFields`): stable `processId` (a UUID, not the
  per-generation counter), `command` identity (`executable`, `args`, `cwd`, never `env`: it can hold
  secrets), log file names, `survivable`, `startedAt`, `placement`, `agentGeneration` (count of Agent
  starts, for diagnostics). Records are written **before** the Project is reported as started and
  removed only after the process is proved dead (existing rule).
- Output: the Agent tails both files with bounded reads (poll every ~250 ms, or `fs.watch` with a poll
  fallback), splits lines with the existing `lineReader`, feeds the existing `onOutput`/replay buffer.
  Keep an offset per stream. **Bound the files:** when a file exceeds a cap (suggest 8 MiB) the Agent
  truncates it in place (`O_APPEND` writers continue at the new end); readers that see `size < offset`
  reset to 0. Lost lines around a truncation are acceptable and must be documented.
  A new Agent rebuilds the replay buffer from the last N KiB of each file.
- Exit detection: for a child this Agent spawned, keep `child.on("exit")` (gives code/signal). For an
  adopted process (not our child) poll `isAlive(pid)` plus the existing `processAgeMs` start-time check
  every ~500 ms; on death emit `{code: null, signal: null, requested}` ("status unknown"). Document that
  adopted processes report no exit code.
- Stop/signal: `process.kill(-pid, sig)` on the process group when the record says the process leads its
  own group, else on the pid; SIGTERM, grace, SIGKILL, exactly as today. Verify identity (age check)
  immediately before signalling an adopted pid.

**B. Agent daemon lifecycle** (`cli/agent.ts`, `_agent-ipc.ts` server).

- At start: instead of `runner.reclaim()` killing everything, **adopt**: read records, verify each pid is
  alive and is the recorded process (age tolerance as today, never signal on doubt), load survivors into
  the `processes` map with their persisted `processId`, rebuild replay from log tails, recreate the
  placement lease supervisor from the record's `placement` (a lease that is already stale fences the
  process immediately, as it does today), and delete records of dead processes. Records that fail
  validation are kept and make the sweep refuse to reclaim blindly (existing fail-closed rule).
  Only processes whose records are `survivable: false`, or whose owner is another live Agent, follow the
  old reclaim rules.
- Shutdown on SIGTERM/SIGINT: if a **handover marker** exists (`<data>/agent/handover.json`, written by
  the root updater or by `zelavis agent --prepare-handover`, containing a random nonce, the target release
  and an expiry), close the server and exit 0 **leaving survivable children running**. Without a valid
  marker keep today's behaviour: stop all owned processes (this is what explicit `systemctl stop` and
  uninstall rely on). A marker is single-use: delete it on consumption; ignore an expired one.
- Write `<data>/agent/agent.json` on start: `{ release, pid, startedAt, protocol, survivable: true }`
  (atomic write). The updater and `zelavis doctor` read it. It is the answer to "which release is the
  Agent on".
- Process ids: replace the `p${n}` counter with persisted ids so a rebind by id is unambiguous across
  Agent generations.

**C. Protocol additions** (additive; the Agent must keep answering today's messages so an engine from
the previous release, kept for rollback, still works with a new Agent).

- `hello` reply gains `{ release, protocol, survivable }`.
- `rebind { processId }`: like `attach` but by id and for a handle the client already holds; replies with
  the same shape (`command`, `replay`) or `{ gone: true, exit }` when the process is dead. A process may
  be rebound only if no live socket drives it (same rule as `attach`).
- `attach` keeps its meaning; adopted survivors appear in it with their original `processId`.

**D. Reconnecting client** (`createAgentProcessClientProgram`).

- Replace "any socket close settles every process as exited" with: mark `connection = lost`, keep all
  process handles `running`, retry `connect` with bounded exponential backoff (cap total time, e.g.
  90 s, then give up and settle handles as exited with an explicit "Agent unreachable" reason so a
  permanently gone Agent still surfaces).
- After reconnect and `hello`, `rebind` every live handle by id; re-register output listeners; handles
  whose process is `gone` settle with the returned exit. Requests issued during the gap wait (bounded,
  not failing fast) so a driver's `stop` during an Agent handover works.
- This also makes an **Agent crash** recoverable (systemd restarts it, survivors are adopted), which
  today kills every Project. Test it explicitly.
- Controllers must not observe a spurious `Exited` event for a rebound process. Add a test with a real
  plan controller on top of a real client and a real Agent restart.

**E. systemd unit** (`distribution/runtime/zelavis-agent.service` and `@.service`).

- `KillMode=process` so systemd signals only the Agent's main pid on stop/restart and leaves children.
  (The Agent itself stops its children on a normal, marker-less shutdown, see B.) Keep `Delegate=yes`.
  Consider `SendSIGKILL=no` for the same reason and `TimeoutStopSec` long enough for a normal shutdown.
- Think through cgroup consequences: leftover processes stay in the unit's cgroup after the main pid
  exits; the restarted unit shares that cgroup. Confirm `systemd` does not stop the unit as "deactivating"
  while stragglers run (`KillMode=process` leaves them with a warning) and that cgroup limits still apply.
  Prove this in the Docker systemd gate, not by reasoning.
- Uninstall must still remove everything: with `KillMode=process`, `systemctl stop` of the unit relies on
  the Agent's own shutdown (no marker) to stop children. Add a fallback in the uninstall plan that kills
  remaining processes of the unit's cgroup (`systemctl kill --kill-who=all`) after the stop. Update the
  complete-uninstall inventory and its isolated destructive-path test (AGENTS.md requires this whenever
  the installer starts owning a resource: `agent.json`, `handover.json`, the log files).

**F. Updater step** (`_update-runner.ts`, `installation-plan.ts`).

After the engine is committed and healthy (or inside the live `install --live` root transaction, after
the inventory commit), compare `agent.json.release` with the target. If different:
1. Write the handover marker (nonce, target, expiry ~2 minutes).
2. `systemctl restart <agent unit>`.
3. Wait for `agent.json` to show the target release and for the Platform engine's client to have
   rebound (poll the diagnostics: every Project the Platform lists as running is still running, with
   unchanged process pids).
4. Failure handling: if the new Agent does not come up, `Restart=on-failure` and the marker's expiry
   mean the previous release's Agent code is no longer selectable because `current` moved. Decide and
   document the rollback story explicitly (suggested: the updater pins the unit to the previous release
   path for one retry, then reports the update as failed-with-Agent-degraded; survivors keep running
   either way because they are independent processes). The order "engine first, Agent second" means a
   failed Agent step must not roll back the engine; record it in the update history instead.
Keep the user-mode installation (no root, no systemd) working: there the Agent is started by the host;
define the equivalent handover or state plainly that user-mode Agent follows on next start.

## 5. Order of work (each step ends green and committed)

1. **Records and survivable spawn** behind a `survivable` option of the runner, with unit tests that spawn
   real processes, kill the "Agent" (the test process), start a second runner on the same state
   directory and prove adoption, output replay, stop, signal, exit detection and pid-reuse refusal.
2. **Agent daemon adoption and handover marker**, `agent.json`, persisted process ids, lease
   supervisors rebuilt. Tests with the real `zelavis agent` as a child process: start Projects through
   a client, `SIGTERM` with a marker, start a second Agent, assert same pids and no restarts; without a
   marker assert everything stops.
3. **Protocol additions and the reconnecting client**, including the crash case (`kill -9` the Agent,
   restart it, handles rebind, controller sees no `Exited`). Seeded fault/model tests for the
   reconnect state machine (interleave disconnects with stop/start requests), per TigerStyle, with
   reproducible seeds.
4. **Unit files, updater step, uninstall inventory, doctor output.**
5. **Release gates:** extend `qualify-installed-update` so that, from a release that already has
   survivable Agents to the candidate, a continuous-traffic update ends with the Agent on the candidate
   release and every Project process pid unchanged (assert from `ps` and from
   `GET /runtime/debug/processes`). Extend `qualify-history` for the conversion path (section 7).
6. **Docs and records:** `updates.md`, `AGENTS.md` (the paragraphs on separately supervised Agents and
   "Installations without the protocol need one full local installer conversion"), `docs:check`,
   `pnotes/TODO.md`, a changeset.

## 6. Failure modes the design must answer (write a test for each)

- Agent killed with SIGKILL mid-start of a process (record written, pid not yet alive, or alive but
  record missing). A record without a process is deleted; a Project process without a record is
  unmanageable, so write the record **before** `exec` completes where possible, and refuse to report
  "started" until it exists (existing rule for placement-bearing commands).
- pid reuse between Agent generations (existing `processAgeMs` rule; never signal on doubt).
- Log file deleted or replaced under a running process (the Agent must not crash or follow a symlink: use
  `lstat` and `O_NOFOLLOW`, keep the directory 0700 owned by the Agent user).
- Two Agents at once (a stale unit and a manual run): the endpoint directory/socket already refuses a
  second listener; add a kernel lock on `<data>/agent/agent.lock` held for the Agent's life so adoption
  is single-writer. Never emulate the lock with a read-then-write.
- Platform engine rolled back after the Agent moved forward: the previous engine must work against the
  new Agent (additive protocol only). Test with the previous release's client code if feasible.
- Placement lease expires while no Agent runs (handover window): the new Agent's first check fences the
  process; make sure the handover window is short and that fencing stays authoritative.
- A handover marker that outlives its purpose (expired, wrong nonce, from a previous boot) must be
  ignored and removed.
- Disk full or log write failure for a child: the child sees EIO/ENOSPC, not the Agent; make sure the
  Agent's tailing does not spin.

## 7. One-time conversion of installations that already run an old Agent

An Agent older than this change (the owner's VPS runs alpha.27) cannot hand over: its children hold pipes
to it and die with it, and its unit has `KillMode=control-group`. The first update that carries the new
Agent must therefore restart that old Agent the old way once. Make it explicit and as gentle as possible:

- Detect it: no `agent.json`, or `agent.json.survivable !== true`.
- The updater installs the new unit file first (`KillMode=process`), then restarts the Agent; the old
  Agent stops its children on a marker-less SIGTERM, the new Agent starts empty, and the Platform's
  existing desired-running restoration brings Projects back. Use the same request hold the recipe upgrade
  uses (`ingressReady`/Gateway hold) so visitors wait instead of failing for the few seconds involved.
- Record in the update history and the dashboard banner that this update restarted Projects once and why.
- Qualify it in `qualify-history` (an old-Agent installation updated through Update now, Projects
  back and serving, zero failed requests ideally, a few seconds of held requests acceptable).
- This is the documented "pre-handover conversion" gap in AGENTS.md. Do not generalise it into a
  permanent compatibility path; delete the conversion code once no supported installation predates it
  (pre-release: after the owner's server is converted, the code can go in the next release).

## 8. Acceptance criteria

- On a Docker/systemd test installation: update from release N (survivable Agent) to N+1 under
  continuous traffic. After the update: Agent release equals the target release; every Project process
  has the same pid and start time as before; zero failed requests; `zelavis debug processes` shows no
  duplicates.
- `kill -9` of the Agent: it restarts, adopts, Projects keep serving, the Platform shows no crash and no
  restart.
- Marker-less `systemctl stop zelavis-agent` and the uninstall plan leave no Project process behind.
- Old-Agent installation updates through Update now with the single documented conversion restart.
- `pnpm run verify`, `pnpm run ci:ui`, `pnpm run docs:check` and `pnpm run release:check` are green; the
  owner publishes (npm login and 2FA are theirs).

## 9. Open questions to settle early (look in the code, then decide and record the decision)

1. Does anything besides the `zelavis agent` daemon use the IPC client and rely on "disconnect means
   exited"? (Remote environment sessions, the dev-mode Agent started by `pnpm dev`, worker Agents.)
2. How does the Fabric custody session (`runtime-custody.json`, `_node-platform-host.ts`) interact with a
   changed Agent generation? Placement `{owner, epoch}` must not change; confirm nothing keys on the
   Agent pid or the `p<n>` ids.
3. macOS/user-mode installs have no systemd: what is the supported Agent handover there (the persistent
   host starts the Agent)? Minimum: document and test that the Agent follows at next start.
4. Is a long-lived `KillMode=process` unit acceptable with `Delegate=yes` and the operation cgroup layout in
   `_linux-cgroup-supervisor.ts` (the Agent moves itself into `agent/`; children stay in the unit root)?
5. Whether the exit status of adopted processes matters enough to justify per-child shims later.

## 10. Practical notes for the implementing agent

- Work on `dev`, in the repository checkout. Do not create worktrees or release folders outside it.
- `packages/zelavis/services/zelavis-ui/node_modules/fuzor` may point at a local Fuzor checkout after
  running UI scripts; before `pnpm release:check` run `rm` on that link and `pnpm install --frozen-lockfile`,
  then `ZELAVIS_FUZOR=npm pnpm release:check`, and run nothing else in the repo while it runs.
- To look at a live server read-only, the owner can give a Debug-preset API key
  (`zelavis debug processes|updates|project <id>`, `GET /zelavis/api/v1/runtime/debug/...`). Never store
  such a key.
- Commit messages end with the attribution trailer the harness gives you; never stage `HANDOVER.md`.
