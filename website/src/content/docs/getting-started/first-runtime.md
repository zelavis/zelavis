---
title: First Runtime
---
This page shows the simplest current way to start Zelavis.

## Quick start

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { createNodeServer } from "zelavis/node";

const zv = new Zelavis({
  adapter: nodeAdapter(),
});
const server = await createNodeServer(zv);

server.listen(3000);
```

This is the preferred application-facing shape. Examples use `zv` as the short local name for a `Zelavis` runtime instance.

When you need direct access to the initialized runtime object, jump to [Advanced Runtime Access](../guides/advanced-runtime-composition.md).

## What you get by default

During the Platform/App migration, a default development runtime mounts the
current Zelavis App service set in-process:

- dashboard
- auth
- database
- website
- workloads

When the selected adapter provides file storage, Zelavis can also expose:

- storage

Default root namespace:

```txt
/zelavis
/zelavis/marketplace
/zelavis/projects/:projectId
/zelavis/projects/:projectId/marketplace
/zelavis/projects/:projectId/settings
/zelavis/server
/zelavis/server/domains
/zelavis/server/backups
/zelavis/server/logs
/zelavis/assets/*
/zelavis/api/v1/runtime/config
/zelavis/api/v1/runtime/settings
/zelavis/api/v1/auth
/zelavis/api/v1/database
/zelavis/api/v1/storage/files/*
/zelavis/api/v1/storage/files/*?format=metadata
/zelavis/api/v1/website/pages
/zelavis/api/v1/workloads
/zelavis/api/v1/workloads/http/:projectId/*path
```

The dashboard root at `/zelavis` opens the Projects overview. Create a project there, then open its project-local pages under `/zelavis/projects/:projectId/*`.

The global Marketplace at `/zelavis/marketplace` is for apps, starters, templates, and server provider plugins. Project plugins live inside Zelavis-native projects at `/zelavis/projects/:projectId/marketplace`. Global management areas such as Domains, Resources, Server, and Security sit outside project URLs; server-owned backing routes currently live under `/zelavis/server/*`.

The website service also mounts public website pages at `/`, while still reserving the dashboard namespace under `/zelavis`.

Platform settings, project registry data, and service installation state are
stored in the Platform System Store. Local adapters use
`.zelavis/system/zelavis.sqlite`. The Platform does not expose that store in a
project Database screen. Each Zelavis App project has an app database at
`.zelavis/projects/<projectId>/.zelavis/zelavis.sqlite` and private runtime
metadata at `.zelavis/projects/<projectId>/.zelavis/runtime/zelavis.sqlite`.

The runtime lists project app services at
`GET /zelavis/api/v1/runtime/app-services`. See [Platform OS and App
Services](../architecture/platform-app-services.md).

## Dashboard settings

The built-in dashboard settings endpoint currently exposes:

- `rootPath`
- `pendingRootPath`
- `apiBasePath`
- `theme`
- `pageBuilderEnabled`
- `persistence`
- `editable`
- `restartRequired`

Root path changes are stored as pending runtime settings and require a restart before the dashboard actually moves.

## Use the fetch-style runtime directly

When the self-hosted handler already speaks the Web `Request` -> `Response` model (Bun, Next.js App Router on Node, future Deno, etc.), no framework helper is needed — call `zv.fetch(request)` directly:

```ts
import { Zelavis } from "zelavis";

const zv = new Zelavis();
const response = await zv.fetch(
  new Request("http://localhost/zelavis/api/v1/runtime/config"),
);
```

## Next

- [Node adapter](../adapters/node.md)
- [zelavis package](../packages/zelavis.md)
- [@zelavis/server](../packages/server.md)
