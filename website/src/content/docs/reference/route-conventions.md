---
title: Route Conventions
---
The default Zelavis runtime mounts the dashboard under a safe root path and groups API services under a versioned API namespace.

## Default mounted paths

With the default runtime settings:

```txt
/zelavis
/zelavis/settings
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
- The dashboard shell and dashboard client routes live under `rootPath`.
- Static dashboard assets live under `${rootPath}/assets/*`.
- Service APIs live under `${rootPath}${api.prefix}/${api.version}/...`.

With:

```ts
new Zelavis({
  rootPath: "/admin",
  api: {
    prefix: "/api",
    version: "v2",
  },
});
```

That example uses the preferred high-level entrypoint. Use the lower-level `zelavis(...)` function only when you need internal runtime composition controls in addition to route customization.

the mounted paths become:

```txt
/admin
/admin/settings
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

## Website core service

When the built-in website core service is enabled, public website pages are mounted at `/`.

Important rules:

- `/` can serve the home page managed by the website core service.
- Zelavis reserves the configured dashboard root path and anything under it.
- Creating a website page at the active dashboard root path is rejected.

## Service app routes

Services that declare an `app` field are synthesized into normal Zelavis service routes.

System services keep the mount chosen by the operator. The built-in `@zelavis/ui` dashboard is a system app service, so the runtime mounts it under the configured dashboard root path.

Workspace services are safer by default:

- with `app.domainPolicy: "optional"`, a workspace app falls back to `/apps/<service-name>` when no verified domain binding exists
- with `app.domainPolicy: "required"`, a workspace app is not served until the runtime has a verified domain binding for that workspace or service
- when a verified binding exists, the app can serve its declared mount on that host, for example `/` on `shop.acme.com`

Concrete hostnames live in runtime domain bindings, not in service package metadata.

## Related docs

- [Dashboard Settings](./dashboard-settings.md)
- [Service Model](../architecture/service-service-model.md)
- [First Runtime](../getting-started/first-runtime.md)
- [@zelavis/server](../packages/server.md)
