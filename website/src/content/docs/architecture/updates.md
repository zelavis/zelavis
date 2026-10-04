---
title: Updating Without Downtime
description: One persistent runtime host and engine handover for the Zelavis Platform and its Apps.
---

The Platform and Zelavis Apps use the same Zelavis engine and the same Effect v4
handover. A persistent host owns their HTTP listener while replaceable engine
processes own their stores. The Platform retains Fabric and server authority;
an App receives only its Project authority.

## Updating the Platform

Installer-managed installations check npm for newer versions on their channel:
`alpha` for an alpha release, `latest` for a stable release. Checks happen on
startup and every six hours. Use **Update now** in the dashboard, or the matching
operations:

- CLI: `zelavis update status|check|apply [--wait]`.
- SDK: `client.updates.status()`, `.check()` and `.apply()`.
- HTTP: `GET /runtime/updates`, `POST /runtime/updates/check` and
  `POST /runtime/updates/apply`.

Viewing requires `system.updates.view`; checking and applying require
`system.updates.manage`.

The unprivileged Platform writes an update request. On system installations,
the root-owned `zelavis-update.path` and `.service` consume it. User installations
start the same updater as the installation's user. The updater ignores request
contents, resolves the newest channel version itself, and uses the same npm and
nodejs.org HTTPS sources as the installer.

An update prepares the immutable release and its private Node while the old
engine serves. The host then pauses new admission, drains accepted requests,
qualifies running Project custody, and releases the old engine's writable state.
Only after that release may the candidate open the System Store. Its readiness
probe must also prove that running Projects were adopted at their existing
addresses. The root installer acknowledges the `current` link, private receipt
and public version descriptor before traffic resumes. The host and its public
listeners keep running throughout.

A failed preparation or drain leaves the previous engine serving. A failed
activation or inventory commit fences the candidate before restoring the old
engine at a fresh generation. A rollback which cannot prove exclusive ownership
keeps admission paused and reports that recovery is required. A stream or
WebSocket that cannot drain within the deadline aborts the update and stays
connected to the previous engine. Admission has a bounded queue; overload is
reported rather than retained indefinitely.

Progress lives in `<data>/update/status.json`. The dashboard follows it and
reloads once the new version is active. The updater retains qualified engine
releases and versions selected by other installation instances. Root updates do
not rewrite Project engine or recipe locks.

### Converting an installation without the persistent host

An installation that predates this handover protocol needs one full local
installer run. That conversion restarts its old process: an already running
older process cannot retroactively preserve accepted connections. The live
installer refuses unsupported protocols and inconsistent inventory. It does
not retain an older execution path or silently fall back to a restart.

After conversion, ordinary dashboard updates use the persistent host. A full
installer rerun remains a maintenance/repair operation and may stop the
Platform. Plain npm/source copies report that updates are manual.

## Updating a Zelavis App

**Upgrade recipe** updates a running native App when its reported
`zeroDowntimeUpdates` capability is true. The same operation is
`client.projects.upgrade(id)`, `POST /runtime/projects/:id/upgrade`, or
`zelavis projects upgrade <id>`.

Installed Apps lock both their recipe artifact and their complete Zelavis engine
artifact, including its private Node. An explicit App upgrade selects the latest
qualified installed engine along with the chosen recipe. New Apps use that same
engine default, even if their parent runs an older version. Parent updates and
rollbacks preserve existing App locks. Public controls for selecting another
exact engine version, including an older one, remain planned.

The candidate is frozen separately while the previous engine serves. The host
journal and the Platform's durable Project update must agree before queued
requests resume. Reconciliation settles interrupted updates from proved host
selection. A deletion tombstone takes precedence; an explicit stop can fence a
failed update but cannot erase its intent without ownership proof.

The App host keeps Gateway replay history across engine replacement. It accepts
parent authority before queuing and creates fresh private worker authority after
admission. Re-keying a surviving App host uses the authenticated Agent process
pipe, not a public control endpoint.

## Project and visitor continuity

System installations run the Project Agent in its own systemd unit. A Platform
engine transfers its Agent handles without stopping supervised Projects or
releasing their placement custody. Local development keeps equivalent custody
in the persistent host. Running native Apps and the qualified WordPress recipe
can be adopted; a driver that cannot prove continuity refuses the handover
before releasing the old engine.

Project preview listeners belong to the persistent host and share its admission
queue. Their ports, visitor Host headers, redirects and site cookies survive
Platform handover. Linux WordPress Unix sockets live in shared installation data,
so the Platform and Agent can use them despite their separate private `/tmp`
mounts. Traefik remains independently supervised.

## Integrity and recovery

An installed engine must match its exact version, complete file digest and
contained dependency-link graph. Tags, ranges, redirected release directories,
unqualified protocols and altered artifacts are refused. This is integrity
within the existing HTTPS distribution trust model, not a release signature.

Each host holds a kernel journal lock and each writable engine holds an exclusive
kernel ownership lock. Journals and inventory writes flush files and directories.
Recovery proves previous engines are fenced before granting a new generation;
an aborted attempt never reuses its generation. An unexpected selected-engine
exit pauses admission and wakes its supervising host for restart.

`zelavis doctor` checks installation inventory, paths, processes, ports and units
without opening Project databases. Complete uninstall removes the persistent
host state along with the selected installation's Projects and data.

Multi-host availability, public independent-version selectors and stronger
isolation backends remain separate planned work. Native process execution is
operational isolation for trusted code, not a hostile-code sandbox.
