---
title: Route Conventions
---
The default Zelavis runtime mounts the dashboard under a safe root path and groups API services under a versioned API namespace.

## Default mounted paths

With the default runtime settings:

```txt
/zelavis
/zelavis/marketplace
/zelavis/projects/default
/zelavis/projects/default/marketplace
/zelavis/projects/default/settings
/zelavis/server
/zelavis/server/domains
/zelavis/server/backups
/zelavis/server/logs
/zelavis/assets/*
/zelavis/api/v1/runtime/config
/zelavis/api/v1/runtime/settings
/zelavis/api/v1/auth/*
/zelavis/api/v1/database/*
/zelavis/api/v1/storage/files/*
/zelavis/api/v1/storage/files/*?format=metadata
/zelavis/api/v1/website/pages
```

## Root path behavior

- `rootPath` defaults to `/zelavis`.
- `/zelavis` opens the Projects overview.
- Project-local dashboard pages live under `${rootPath}/projects/:projectId/*`.
- Global Marketplace and server management live outside project URLs.
- Project marketplace lives under `${rootPath}/projects/:projectId/marketplace`.
- Managed app projects may expose hosting-style project pages instead of Zelavis-native backend pages.
- The dashboard shell and dashboard client routes live under `rootPath`.
- Static dashboard assets live under `${rootPath}/assets/*`.
- Service APIs live under `${rootPath}${api.prefix}/${api.version}/...`.

With:

```ts
const zv = new Zelavis({
  rootPath: "/admin",
  api: {
    prefix: "/api",
    version: "v2",
  },
});
```

That example uses the preferred high-level entrypoint and the standard `zv` local instance name.

the mounted paths become:

```txt
/admin
/admin/marketplace
/admin/projects/default
/admin/projects/default/marketplace
/admin/projects/default/settings
/admin/server
/admin/server/domains
/admin/server/backups
/admin/server/logs
/admin/assets/*
/admin/api/v2/runtime/config
/admin/api/v2/runtime/settings
/admin/api/v2/auth/*
/admin/api/v2/database/*
/admin/api/v2/storage/files/*
/admin/api/v2/storage/files/*?format=metadata
/admin/api/v2/website/pages
```

The storage routes are present when Zelavis has a file storage resource to expose through the storage core service. `?format=metadata` returns structured file information and the ready-to-use Zelavis file reference for that path.

## Endpoint-backed capabilities

Dashboard routes are client routes. Platform actions should live under the API namespace as service endpoints.

If a dashboard surface can run a check, mutate settings, create a domain, install a service, manage backups, change project state, or read operational telemetry, the same capability should be reachable through `${rootPath}${api.prefix}/${api.version}/...`.

This keeps the dashboard, CLI, AI agents, plugins, scripts, and external admin tools on the same platform contract.

## Website core service

When the built-in website core service is enabled, public website pages are mounted at `/`.

Important rules:

- `/` can serve the home page managed by the website core service.
- Zelavis reserves the configured dashboard root path and anything under it.
- Creating a website page at the active dashboard root path is rejected.

## Service app routes

Services that declare an `app` field are synthesized into normal Zelavis service routes.

System services keep the mount chosen by the operator. The built-in `@zelavis/ui` dashboard is a system app service, so the runtime mounts it under the configured dashboard root path.

Extension services are safer by default:

- with `app.domainPolicy: "optional"`, an extension app falls back to `/apps/<service-name>` when no verified domain binding exists
- with `app.domainPolicy: "required"`, an extension app is not served until the runtime has a verified domain binding for that project or service
- when a verified binding exists, the app can serve its declared mount on that host, for example `/` on `shop.acme.com`

Concrete hostnames live in runtime domain bindings, not in service package metadata.

## Related docs

- [Dashboard Settings](./dashboard-settings.md)
- [Endpoint-Backed Capabilities](../architecture/endpoint-backed-capabilities.md)
- [Service Model](../architecture/service-model.md)
- [Project Model](../architecture/project-model.md)
- [First Runtime](../getting-started/first-runtime.md)
- [@zelavis/server](../packages/server.md)
