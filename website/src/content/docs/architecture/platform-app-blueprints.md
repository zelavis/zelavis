---
title: Platform OS, App, and Blueprints
---

Zelavis is split into a control plane and the projects it manages. This is an
ownership boundary, not only product naming.

## Zelavis Platform OS

The `zelavis` package is the installed Platform OS. It owns the long-running
control plane, dashboard, project registry, server and domain management,
platform access control, system services, blueprint catalog, installation
state, and lifecycle orchestration.

Platform records belong in the **System Store**. The default local adapters use
SQLite at:

```text
.zelavis/system/zelavis.sqlite
```

The System Store is not a user project database. It must never appear as a
table in a project's Database screen or be exposed through `@zelavis/db`
document APIs.

## Zelavis App

Zelavis App is the official first-party application backend: the combination
of application database, application auth, storage, and optional workload
services that competes with Firebase and Supabase.

Zelavis App is a project stack, not the Platform OS. The current Node host runs every
Zelavis App project in an independent process and data directory. A future production
driver can replace this boundary with a rootless OCI container or stronger
isolation.
Application identities inside a Zelavis App project are separate from Platform OS
operator/customer identities unless an explicit bridge or SSO mapping connects
them.

`@zelavis/server` remains a reusable runtime and endpoint kernel. The Platform
OS can use it for control-plane endpoints, and an isolated Zelavis App runtime can use
it for project endpoints without importing the whole Platform OS.

There is one dashboard application, mounted by the Platform OS from
`@zelavis/ui`. Zelavis App runtimes are headless and do not serve their own dashboard
bundle. They expose runtime metadata, APIs, and service menus through
`@zelavis/server`; the Platform dashboard reads those endpoints through the
project proxy and renders the selected project's navigation.

## Blueprints

A Blueprint is a versioned, production-oriented project recipe. It describes
the project kind, runtime, required services, installation inputs, lifecycle
metadata, and eventually update and rollback behavior. Zelavis App is the
flagship official Blueprint, alongside future WordPress, Laravel, Drupal,
static-site, and other recipes.

A Blueprint is not a service and has no separate dashboard menu API. Its
manifest selects and locks versioned services. Those installed services use the
ordinary service contract to declare fixed menu items, nested slides, dynamic
sections, and service-owned pages. This lets every project use one navigation
contract without making provisioning recipes executable dashboard extensions.

The published `zelavis` package ships its offline catalog in:

```text
packages/zelavis/blueprints
```

Downloaded or cached versions live in:

```text
.zelavis/blueprints
```

Created projects lock the exact Blueprint id and version in
`.zelavis/projects/<project-id>/blueprint.lock.json`. `latest` is a catalog
selector, not a reproducible project version.

The current runtime exposes the catalog through:

```text
GET /zelavis/api/v1/runtime/blueprints
```

Project lifecycle is endpoint-backed:

```text
GET    /zelavis/api/v1/runtime/projects
POST   /zelavis/api/v1/runtime/projects
GET    /zelavis/api/v1/runtime/projects/:projectId
POST   /zelavis/api/v1/runtime/projects/:projectId/start
POST   /zelavis/api/v1/runtime/projects/:projectId/stop
GET    /zelavis/api/v1/runtime/projects/:projectId/logs
DELETE /zelavis/api/v1/runtime/projects/:projectId
```

## Current migration state

Implemented now:

- runtime-neutral Blueprint manifest and registry contracts
- shipped Zelavis App manifest in the published package
- local Node/Bun catalog loading with a runtime cache overlay
- a separate Platform System Store contract
- default local SQLite System Store persistence
- dashboard settings and service registry persistence through the System Store
- one `pnpm dev` command for the runtime and React Router dashboard
- endpoint-backed project creation and lifecycle
- exact Blueprint lock files and independent project data directories
- the default `node-process` runtime driver
- project API proxying so project dashboard actions reach the selected runtime
- one Platform dashboard with headless project runtimes
- project navigation composed from the selected runtime's service menu metadata

Still being migrated:

- the Platform migration runtime still mounts Zelavis App services in-process
  for global development surfaces while that transitional composition is removed
- the process driver is operational isolation for trusted code, not a security
  sandbox and not the final hosting-provider boundary
- resource limits and rootless OCI/container orchestration are not implemented

During this migration, do not move existing project data into the System Store
and do not use `@zelavis/db` as a fallback for Platform OS records.
