---
title: Platform OS and App Services
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
table in a project's Database screen or be exposed through `@zelavis/app/db`
document APIs.

The Platform process does not mount an app-facing database service by default.
In repository development, its System Store lives at
`examples/nodejs/.zelavis/system/zelavis.sqlite`.

## App Services

Project boilerplates are services with `kind: "app"`. The service definition is
the create-project unit: it owns the menu metadata, setup behavior, default
files, provisioning hooks, and the app-facing runtime services it wants to
mount inside the created project.

The published `zelavis` package ships official services in:

```text
packages/zelavis/services
```

The first official app service is `@zelavis/app`, the Zelavis-native backend
that composes application database, application auth, and workloads. Future
WordPress, Drupal, static-site, or other project boilerplates should use the
same `kind: "app"` service shape.

The current runtime exposes available app services through:

```text
GET /zelavis/api/v1/runtime/app-services
```

Creating a project locks the selected app service into:

```text
.zelavis/projects/<project-id>/project.json
```

The Node process driver then starts a headless project runtime with that app
service installed.

## Zelavis App

Zelavis App is a project stack, not the Platform OS. The current Node host runs
every Zelavis App project in an independent process and data directory. A future
production driver can replace this boundary with a rootless OCI container or
stronger isolation.

For the Node process driver, each project lives below
`.zelavis/projects/<project-id>`. Its application database is
`.zelavis/zelavis.sqlite`; private runtime metadata is stored separately in
`.zelavis/runtime/zelavis.sqlite` inside that project directory.

There is one dashboard application, mounted by the Platform OS from
`@zelavis/ui`. App project runtimes are headless and do not serve their own
dashboard bundle. They expose runtime metadata, APIs, and service menus through
`@zelavis/app/server`; the Platform dashboard reads those endpoints through the
project proxy and renders the selected project's navigation. App services must
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
```

Implemented now:

- `kind: "app"` services in the service contract
- a shipped official `@zelavis/app` service
- a shipped `packages/zelavis/services` directory
- local Node/Bun registration of official app services
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
`@zelavis/app/db` as a fallback for Platform OS records.
