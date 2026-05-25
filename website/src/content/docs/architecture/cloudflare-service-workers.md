---
title: Cloudflare Service Workers
---
Zelavis service activation on Cloudflare is a worker-boundary problem, not a core runtime mutation problem.

The core rule remains:

- Zelavis core stores service registry state.
- Zelavis core exposes standard service activation requests.
- The Cloudflare adapter decides how those requests map to Cloudflare infrastructure.

## Current contract

The Cloudflare adapter exposes `createCloudflareDispatchServiceActivation(...)`.

That helper sends a standard `POST` request to a Worker resolved from a dispatch namespace:

```txt
POST /__zelavis/service/activate
content-type: application/json
```

Request body:

```json
{
  "serviceName": "search",
  "action": "install",
  "specifier": "https://example.com/search.mjs",
  "registry": []
}
```

Response body:

```json
{ "status": "active" }
```

or:

```json
{ "status": "pending", "message": "Deployment still propagating." }
```

## Service Worker responsibilities

A service Worker owns the service's isolated runtime surface. It can:

- accept activation requests from Zelavis
- validate the requested service version or source
- prepare its own bindings, caches, or metadata
- expose service-owned routes through the host's dispatch strategy

The service Worker should not need direct access to Node.js APIs, Zelavis internals, or the dashboard React tree.

## Future deploy and upload layer

The Marketplace upload or install flow should eventually call a Cloudflare-specific deploy capability before activation.

That deploy capability is intentionally not in Zelavis core. It belongs in the Cloudflare adapter layer or a Cloudflare management package because it needs Cloudflare account credentials, upload APIs, dispatch namespace configuration, and platform-specific failure handling.

Recommended flow:

1. Marketplace stores service registry metadata.
2. Cloudflare deploy capability uploads or updates the service Worker.
3. Zelavis calls `activate(...)` on the adapter service activation controller.
4. `createCloudflareDispatchServiceActivation(...)` sends the activation request to the dispatched service Worker.
5. The service Worker returns `active` or `pending`.
6. The dashboard reflects the activation result.

This keeps runtime service installs possible without requiring a restart or redeploy of the main Zelavis Worker.

## Related docs

- [Cloudflare Adapter](../adapters/cloudflare.md)
- [Service Model](./service-service-model.md)
