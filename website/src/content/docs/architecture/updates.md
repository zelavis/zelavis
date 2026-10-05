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
and public version descriptor before traffic resumes. System installations also
refresh the selected release's authored systemd templates and reload the unit
catalogue at that acknowledgement; they do not restart the host or Project Agent.
Rollback restores the previous release's templates. The host and its public
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
rollbacks preserve existing App locks.

The create form offers **Zelavis version**, defaulting to the latest available
engine. An existing native App offers **Manage version** on its Project card.
These controls select exact, already installed and qualified engine versions;
they do not download arbitrary npm versions. Every selection uses that engine's
bundled App recipe. Source installations and unsupported drivers explain why
independent version selection is unavailable.

The same controls are available through:

- SDK: `client.projects.versions(id?)`, `.switchVersion(id, version)` and
  `.create({ name, engineVersion })`.
- HTTP: `GET /runtime/project-versions`,
  `GET /runtime/projects/:id/versions`, and
  `POST /runtime/projects/:id/version` with `{ "version": "2.0.0-alpha.17" }`.
- CLI: `zelavis projects versions [id]`,
  `zelavis projects switch-version <id> --engine-version <exact-version>`, and
  `zelavis projects create <name> --engine-version <exact-version>`.

Reading Project choices requires `project.view`; switching requires
`project.runtime.manage` for that Project. Listing choices for creation requires
`projects.list`. Engine selection remains an explicit lifecycle operation:
parent updates do not change it, deletion blocks it, and interrupted switches
retain their durable recovery state. Qualification of an engine artifact proves
its integrity and protocol. It does not promise that arbitrarily old software
can read data written by every future release; incompatible data formats must
be refused before writable ownership is granted.

The candidate is frozen separately while the previous engine serves. The host
journal and the Platform's durable Project update must agree before queued
requests resume. Reconciliation settles interrupted updates from proved host
selection. A deletion tombstone takes precedence; an explicit stop can fence a
failed update but cannot erase its intent without ownership proof.

The App host keeps Gateway replay history across engine replacement. It accepts
parent authority before queuing and creates fresh private worker authority after
admission. Re-keying a surviving App host uses the authenticated Agent process
pipe, not a public control endpoint.

## Updating a managed app recipe

WordPress and future managed apps such as Drupal, Shopware, PrestaShop, TYPO3
and Joomla own their software updates. Updating their **Project recipe** refreshes
the Zelavis integration, including its locked metadata and dashboard entry. It
never provisions the app again, downloads replacement application software,
rewrites its runtime configuration, or stops/restarts its service.

Managed app cards offer **Update recipe** through the same
`client.projects.upgrade`, HTTP upgrade endpoint and CLI command. The local
managed-runtime adapter stages and verifies a new immutable recipe, persists the
update intent, and replaces a Project-scoped Zelavis integration worker through
the same persistent host and Effect handover as native Apps. Recipe SDK menus,
REST endpoints, setup-mounted endpoint groups, operation discovery and disk-backed
page assets become active immediately through the existing Project Gateway.
The dashboard reloads Project configuration and versions its page URLs so changed
assets are displayed. WordPress visitors still reach the original web server;
Gateway authority is sent only to the Project integration runtime.

The app supervisor and its processes keep serving throughout. Integration
workers share the Project's Agent/Fabric placement, have no parent Fabric authority,
and keep their private Zelavis state below `.zelavis/integration`. A rejected
activation restores the previous integration before admission resumes. Recovery
of an interrupted commit follows the host's proved immutable selection, including
repair of interrupted canonical file swaps. Stopped managed apps can refresh
their recipe without starting or provisioning the app; their integration runtime
opens when the running Project is accessed.

The bound runtime is an ordinary private Zelavis App with Auth, Database, Storage
and Workloads available by default. It belongs to the same managed Project and
has no separate Project card or public app address. Services use the normal
Project APIs or setup `core` APIs; no feature enable flags are required. Successful
native API requests and service API calls record usage in this private runtime.
The existing native dashboard sections appear only for APIs that have been used,
and that usage survives updates and restarts. Internal identity database access
and opening the dashboard do not activate unused sections. The app's own database
and files remain separate from the bound Zelavis data.

An adopted bound App follows the current qualified Platform engine through the
same handover, without changing its recipe lock or restarting the third-party
app. Visible native Apps keep their explicitly selected engine versions. Native
workload definitions and run logs use the runtime's private durable store so an
integration handover does not discard them.

An integration update must preserve the app identity and deployment contract:
runtime entry, host package set and isolation intent. A changed deployment
contract is refused while the existing app remains available. Changing an app's
software/deployment is a separate app-owned or explicit hosting operation.
This implemented path covers the native managed-runtime contract used by
WordPress; the other named apps are future recipes, not shipped recipes.

Native Zelavis Apps update the complete engine through the same handover used
by the Platform. Their shared composition has scoped Project authority; the
outer Platform's Fabric remains the privileged hosting control plane.

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

Multi-host availability and stronger isolation backends remain separate planned
work. Native process execution is
operational isolation for trusted code, not a hostile-code sandbox.

## Release requirement: Update now always works

Every future architectural change must remain installable through **Update now**.
A terminal command or installer rerun for a normal release is a product defect.
The bootstrap first acquires the npm package with scripts disabled, then reads
its installation assets as JSON. If the candidate changes the pinned private
Node, it fetches that pin from nodejs.org and checks its published SHA-256 before
executing candidate code. Installed unit changes use the existing root commit
authority. No new distribution trust source is introduced.

`pnpm release:check` includes `release:qualify:update`: a disposable Linux/systemd
installation starts with the actual previous npm release, runs the installed
updater against the packed candidate, and checks continuous dashboard, App and
WordPress traffic, data, addresses, process custody and App engine selection in
both directions. Before publication only candidate acquisition is substituted;
this is distinct from claiming an npm end-to-end check. After publication, run
the same qualification with `ZELAVIS_QUALIFY_UPDATE=npm` and
`ZELAVIS_PROVISIONING_FROM_NPM` set to that previous exact release. This uses the
authenticated update API and the installed systemd watcher, exactly as the
dashboard does. Fresh-install and synthetic-version tests alone are insufficient.
