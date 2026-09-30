---
title: Platform OS and Project Recipes
---

Zelavis is split into a control plane and the projects it manages. This is an
ownership boundary, not only product naming.

## Zelavis Platform OS

The `zelavis` package is the installed Platform OS. It owns the long-running
control plane, dashboard, project registry, server and domain management,
platform access control, system services, service installation state, and
lifecycle orchestration.

Platform records belong in the **System Store**. The default local adapters use
SQLite at:

```text
.zelavis/system/zelavis.sqlite
```

The System Store is not a user project database. It must never appear as a
table in a project's Database screen or be exposed through `zelavis/app/db`
document APIs.

The Platform process does not mount an app-facing database service by default.
In repository development through `pnpm dev`, its System Store lives at
`packages/zelavis/.zelavis/system/zelavis.sqlite`.

## Project Recipes

A Project recipe is a service with `kind: "app"`; its optional Project metadata
declares runtime compatibility. It is the create-project unit: it owns menu metadata, setup
behavior, default files, provisioning hooks, and the runtime services mounted
inside the created Project.

Services with `kind: "plugin"` have a different role: they extend the Platform
or a Project runtime rather than being something a Project can be created from.
A plugin does not become a create-project option merely because it is built in.

There is no `core` kind. What makes Auth, Database, Workloads, Fabric, the
dashboard, and the marketplace trusted is that the operator composed them —
`scope: "system"` — not a label on the service.

The published `zelavis` Platform product is assembled from trusted product
services in `packages/zelavis/src/platform` plus its dashboard service in:

```text
packages/zelavis/services
```

The Server Control Plane is a native Platform subsystem, mounted as endpoint
groups rather than as a service. `@zelavis/marketplace`, `@zelavis/auth` and
`@zelavis/ui` are loadable packages bundled in the distribution's `services/`
folder and loaded through the same manifest loader as installed packages.
None is a second backend framework.

The official Project recipe is `@zelavis/app`, a real `kind: "app"` package at
`packages/zelavis/services/zelavis-app` that is bundled and released with the
Platform at the same version. It carries identity, menu and defaults for a Project
built on the built-in App stack (`zelavis/app`, implemented in
`packages/zelavis/src/app`). Recipes for other software, such as
`@zelavis/wordpress`, are separate packages installed through the marketplace and
may ship their own runtime; see [Recipe Runtimes and Managed Apps](./recipe-runtimes.md).

The current runtime exposes available Project recipes through:

```text
GET /zelavis/api/v1/runtime/project-recipes
```

Creating a Project locks the selected recipe into:

```text
.zelavis/projects/<project-id>/project.json
```

The Node process driver then starts a headless Project runtime with that recipe
installed.

The lock holds the recipe's exact name, version and specifier, and a Platform
update never rewrites it. Preparing a Project also freezes the recipe package into
`<project>/.zelavis/recipe/package` and records a content digest in the lock. The
Project runs that copy and refuses to start if it was modified. The engine that
hosts the recipe is still the Platform's own code, so the local Node driver does
not yet run independent runtime versions.

Each Project read reports a `recipeStatus`: `current`, `upgradeAvailable` or
`unavailable` (the locked version is no longer shipped and no frozen copy exists).
The Platform never upgrades a Project on its own. An explicit recipe upgrade
(`POST /projects/:id/upgrade`, `client.projects.upgrade`,
`zelavis projects upgrade`) re-locks a stopped or failed Project to a recipe this
Platform ships. Its new copy is frozen first and swapped in only when complete,
so a failed upgrade leaves the Project as it was, and the data is untouched.

In the future, a Project may become a delegated Project Platform or **Project
Cell** and manage nested Apps inside its allocation. The root Platform still
places and moves the whole cell and retains physical Node/provider authority.

## Zelavis App

Zelavis App is a project stack, not the Platform OS. The current Node host runs
every Zelavis App project in an independent process and data directory. A future
production driver can replace this boundary with a rootless OCI container or
stronger isolation.

For the Node process driver, each project lives below
`.zelavis/projects/<project-id>`. Its logical application database routes
stable virtual shard ranges across physical SQLite files in
`.zelavis/data/primary/shards`; private topology and runtime metadata is stored
separately in `.zelavis/runtime/zelavis.sqlite` inside that project directory.
All shard placements begin on the same Node and can later move without changing
the App-facing database API.

There is one dashboard application, mounted by the Platform OS from
`@zelavis/ui`. App project runtimes are headless and do not serve their own
dashboard bundle. They expose runtime metadata, APIs, and service menus through
the shared `zelavis/core` engine under Project-scoped authority; the Platform
dashboard reads those endpoints through the Project Gateway and renders the
selected project's navigation. Project recipes must
not be executed directly inside the Platform process because that would share
memory, credentials, crash fate, and workload execution with the owner console.

Project lifecycle is endpoint-backed:

```text
GET    /zelavis/api/v1/runtime/projects
POST   /zelavis/api/v1/runtime/projects
GET    /zelavis/api/v1/runtime/projects/:projectId
POST   /zelavis/api/v1/runtime/projects/:projectId/start
POST   /zelavis/api/v1/runtime/projects/:projectId/stop
GET    /zelavis/api/v1/runtime/projects/:projectId/logs
DELETE /zelavis/api/v1/runtime/projects/:projectId
POST   /zelavis/api/v1/runtime/projects/:projectId/upgrade
```

The Platform keeps Project runtime ownership in a conditional System Store
record with a Node owner, session, lease, and increasing epoch. A Fabric plan
alone cannot start a Project. The local Agent verifies the committed placement
before starting a Project process and stops it when that placement expires or
changes. Starting a Project on another machine is implemented, with signed,
single-use authority and a fenced worker Agent; see
[Fabric and Placement](./fabric.md) for what is and is not proven.

Implemented now:

- `kind: "app"` Project recipes in the service contract
- the official `@zelavis/app` recipe, bundled with the Platform
- recipes installed from the marketplace, including ones that ship their own runtime
- frozen recipe artifacts verified by digest, and explicit recipe upgrade
- remote Project start through a fenced worker Agent
- trusted Marketplace, Auth and UI product services
- registration of official Project recipes on the local Node and Bun hosts
- a separate Platform System Store contract
- default local SQLite System Store persistence
- dashboard settings and service registry persistence through the System Store
- endpoint-backed project creation and lifecycle
- independent project data directories and the default `node-process` driver
- project API proxying so project dashboard actions reach the selected runtime
- one Platform dashboard with headless project runtimes
- project navigation composed from the selected runtime's service menu metadata

Current limitations:

- the process driver is operational isolation for trusted code, not a security
  sandbox and not the final hosting-provider boundary
- resource limits and rootless OCI/container orchestration are not implemented

Do not move existing project data into the System Store and do not use
`zelavis/app/db` as a fallback for Platform OS records.

## Project runtimes

A Project runtime is the same composition as the Platform with `role: "project"`.
It composes Identity, Database and Workloads as native subsystems; its accounts
live in the Project's own database rather than the Platform System Store. The
official `@zelavis/app` recipe supplies identity, menu and defaults but mounts no
backend itself. Each Project also has its own services folder inside its
`.zelavis` data root, discovered and loaded like the Platform's, so packages
installed into a Project belong to that Project alone.

A Project's public site is the static frontend package (`kind: "frontend"`)
installed in that folder. It is served at the Project's root straight from the
package directory, and the placeholder answers until one is installed. On the
Platform the same kind of package is mounted under `/apps/<name>`, so it cannot
replace the Platform's own root.

A Project serves one frontend at a time. Choosing one is installing it through
the service registry, which sets the previously installed frontend aside, and the
choice persists across restarts.

A Project's recipe is frozen into it when it is prepared, as described above, so
a Platform upgrade cannot change the recipe an existing Project runs.
