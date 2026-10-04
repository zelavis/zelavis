---
title: Updating Without Downtime
description: What an update interrupts today, and the plan to make a Platform update invisible to visitors and operators.
---

The first section describes what is built: updating a server from its own
dashboard, CLI or API. The rest is a plan for making an update invisible to
visitors; where it says "today" it describes what the code does now, and
everything else is not built.

## Updating from the dashboard (built)

A server installation set up by the installer can update itself (from `2.0.0-alpha.10`;
older installs have no updater, so run the installer once to get it). The Platform
checks npm for a newer version on its own channel (`alpha` for an alpha, `latest`
for a stable release) when it starts and every six hours. When one exists, a banner
shows on every page and Settings has an Updates card with an **Update now** button.
The same operations exist as `zelavis update status|check|apply [--wait]`, the SDK
(`client.updates`) and HTTP (`GET /runtime/updates`, `POST /runtime/updates/check`,
`POST /runtime/updates/apply`). Looking needs `system.updates.view`; checking and
applying need `system.updates.manage` (an owner has both).

The Platform runs as an unprivileged user, so it cannot replace its own release or
restart itself. It only **asks**: it writes a request file into its own
`<data>/update/` folder. A root-owned systemd path unit, `zelavis-update.path`, sees
the file and starts `zelavis-update.service`, which runs `zelavis update --run` as
root. That updater:

1. consumes the request first, so a failure cannot repeat it, and ignores everything
   in it except that it exists;
2. looks up the newest version on the channel of the running version from npm itself,
   and refuses anything that is not newer, so a request can at worst trigger the
   update you could have run by hand;
3. **prepares** the new version while the old keeps serving: the installer that shipped
   inside the installed release fetches the pinned Node and the exact package (no new
   download source) and lays it beside the current release. Nothing running is touched,
   so a failure here changes nothing and nobody notices the download;
4. **swaps**: the new release's own installer selects it and restarts the service once;
5. waits up to 90 seconds for the dashboard to answer;
6. if it does not, or the installer fails, selects the previous release again with that
   release's own installer, and records a rollback with the installer's output;
7. on success keeps the new release and the one it replaced, and removes older ones
   (never one another instance selects).

Progress is a small `status.json` in the same folder, so the dashboard keeps showing
it across the restart and reloads itself onto the new version when it arrives.

### No downtime (built for systemd installs)

systemd holds the dashboard port in `zelavis.socket` and hands it to the Platform
(socket activation, `LISTEN_FDS`), so a restart **queues** connections instead of
refusing them. In a test on Debian 12 with systemd (a request every 50 ms, 500 to 1200
requests per run) an update produced **no failed request** and the slowest took
about 0.4 s. The first update from an install that predates the socket uses the full
installer, with a few seconds of refused connections; every update after that is
live. A rollback of an unstartable release takes about two minutes and restores service.

### Every kind of installation

- **Default system install:** as above (`zelavis-update.path` and `.service`).
- **Named instances:** each has its own `zelavis-update-<name>.path` and `.service`
  (and `zelavis-<name>.socket`), so the dashboard of an instance updates that instance
  alone, to its own release, and never touches another instance's.
- **User installs (macOS, or Linux without systemd):** nothing is root and nothing
  supervises the process. The Platform starts the same updater as the same user. It
  prepares and selects the new release and then says **Restart Zelavis to use it**;
  the old version keeps serving until you restart it. Nothing is restarted behind
  your back, and the release the process runs from is never pruned.
- **Development runs and npm/source copies:** report that updates are manual.

`zelavis doctor` reports whether the watcher (`update-watch`) and the socket
(`socket`) are armed, and complete uninstall removes the units.

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

Project runtimes and visitors are still affected as below; the dashboard row shows what the
socket changed. Measured on a development machine with an empty Platform: the process is serving
about **0.33 s** after start and stops in a few milliseconds. With Projects
running, stopping takes as long as stopping them does.

| Layer | Interrupted by a Platform restart? |
|---|---|
| Dashboard and API | Slower for a moment, not refused, on systemd installs (the socket queues connections). Refused for the restart elsewhere. |
| Project runtimes | Not if a separate Agent supervises them (its own systemd unit; the Platform re-adopts them on start). Yes when the Platform itself runs them, as in development: they stop and are started again. |
| Visitors to a Project's domain | Yes. The Platform process forwards that traffic to the Project today, so it is down while the Platform is. |
| Edge (Traefik) | No. It is its own unit, and its configuration is output the Platform compiles. |
| The System Store | Persistent across restarts. The current Platform data ownership guard refuses a second Platform on the same System Store. Safe overlap needs the leadership/follower coordination below. |

## The plan, in order

Each phase is useful alone and none depends on a later one.

**1. Stop refusing connections. Built** for systemd installs (see above): systemd
holds the listening socket, so a restart queues connections for under half a second
instead of refusing them. Still to do: `/live` and `/ready`, and a dashboard retry
for an API call that fails with a connection error.

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
command (and the Agent, as a host operation like the Edge ones) does:
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
- `zelavis upgrade` as an Agent host operation is no longer needed for the first
  version: the root updater above covers it. It would still matter for updating a
  fleet of servers from a Fabric.

## Orchestration and interruption

The update control and host-local runner use Effect v4. Registry checks share
one in-flight lookup, apply requests serialize, and temporary request/status
files and registry readers have cleanup finalizers. Public update APIs keep
their Promise contracts. Channel checks, the privileged installer boundary,
instance ownership, health checks and rollback remain the update authority;
Effect coordination does not make an update durable by itself.
