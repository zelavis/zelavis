---
title: Updating Without Downtime
description: What an update interrupts today, and the plan to make a Platform update invisible to visitors and operators.
---

This page is a plan. Where it says "today" it describes what the code does now;
everything else is not built.

## Can an update involve no restart?

Not of the process. Node loads an ES module once and cannot unload or replace it,
and a Platform that swapped its own core code in place would be running a mix of
two versions. What can be made invisible is the **interruption**: start the new
version beside the old one, move traffic over, and let the old one finish. So the
goal is "no downtime", reached by overlap, not "no restart".

Services are different, and already work this way: installing one needs no
restart, and an update runs the new version immediately (an acquired package lives
in a folder named by its digest, so the update is a different module). What stays
until the next restart is the previous module's memory; the response says so
(`restartRecommended`).

## What an update interrupts today

Measured on a development machine with an empty Platform: the process is serving
about **0.33 s** after start and stops in a few milliseconds. With Projects
running, stopping takes as long as stopping them does.

| Layer | Interrupted by a Platform restart? |
|---|---|
| Dashboard and API | Yes, for the restart (well under a second when nothing is running). Connections made during it are refused. |
| Project runtimes | Not if a separate Agent supervises them (its own systemd unit; the Platform re-adopts them on start). Yes when the Platform itself runs them, as in development: they stop and are started again. |
| Visitors to a Project's domain | Yes. The Platform process forwards that traffic to the Project today, so it is down while the Platform is. |
| Edge (Traefik) | No. It is its own unit, and its configuration is output the Platform compiles. |
| The System Store | Persistent across restarts. The current Platform data ownership guard refuses a second Platform on the same System Store. Safe overlap needs the leadership/follower coordination below. |

## The plan, in order

Each phase is useful alone and none depends on a later one.

**1. Stop refusing connections.** Hold the listening socket outside the process
(systemd socket activation: `LISTEN_FDS`), so a restart queues connections for
half a second instead of refusing them; add `/live` and `/ready`; make the
dashboard retry an API call that fails with a connection error. A restart becomes
a latency blip with no errors. Small, and the right first step.

**2. Take visitors off the Platform.** Route public Project traffic from Edge
straight to the Project (Edge already compiles routes, and has stage, probe,
activate, drain and rollback operations). Then updating the Platform cannot
touch a visitor, and the Project-forwarding code in the Platform becomes the
development fallback.

**3. Make overlap safe.** Two Platforms must be able to run together for a few
seconds:
- *One leader for background work.* Reconciliation, schedules, ACME renewals and
  allow-list refresh run only in the instance holding a lease in the System Store
  (the same compare-and-set, epoch and fencing pattern Project placement already
  uses). The new instance starts as a follower and takes the lease when the old
  one releases it.
- *Compatible storage.* Version N and N+1 share the System Store while they
  overlap, so a change to a stored shape ships in two steps (add, then remove).
  Pre-release this is waived (existing development data is recreated); the rule
  starts with the first released design.
- *Draining.* The old instance stops accepting new work, finishes in-flight
  requests, and tells long-lived clients (the Assistant's streams) to reconnect;
  their state is stored, so reconnecting loses nothing.

**4. Blue/green.** Releases live in versioned folders with a `current` link (the
shared installer already lays them out this way), so the new version starts from
its own files while the old keeps running from its own. Named installations
also retain independent `instances/<name>/current` links over the shared release
tree. Their separate System Stores are not an implementation of blue/green
overlap on one Store; that still needs phase 3 above. A `zelavis upgrade`
command (and the Agent, as a signed host operation like the Edge ones) does:
start the new release on another port, wait for `/ready`, move Edge to it, drain
the old, and roll back by moving Edge back if the new one fails its probe. A
failed update never takes the old version down.

**5. More than one host.** A System Store several machines can write, and a
Platform per machine. This is high availability, not update strategy, and is
separate from the above.

## By how you installed it

- **Debian package or archive:** phases 1 and 4 apply fully. The package script
  today restarts the unit; it would start the new release instead.
- **`npm|pnpm|bun create zelavis`:** the same versioned release layout and private
  Node as an archive. Rerunning installs or repairs the selected exact release;
  system mode restarts the unit today. User mode requires stopping and restarting
  `zelavis serve` yourself. `npm update` does not manage this installation.
  Blue/green orchestration remains planned for both modes.
- **Development:** a restart is fine, and `Ctrl-C` now waits for Projects to stop
  and releases their placements.

## What is not decided

- Whether the leader lease lives in the System Store or in a separate coordination
  file; the System Store is simpler and is already the authority for placement.
- Whether `zelavis upgrade` ships before the Agent can run it as a signed
  operation (a command an administrator runs is the smaller first version).
