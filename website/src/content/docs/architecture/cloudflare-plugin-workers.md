---
title: Cloudflare Plugin Workers
---
Zelavis plugin activation on Cloudflare is a worker-boundary problem, not a core runtime mutation problem.

The core rule remains:

- Zelavis core stores plugin registry state.
- Zelavis core exposes standard plugin activation requests.
- The Cloudflare adapter decides how those requests map to Cloudflare infrastructure.

## Current contract

The Cloudflare adapter exposes `createCloudflareDispatchPluginActivation(...)`.

That helper sends a standard `POST` request to a Worker resolved from a dispatch namespace:

```txt
POST /__zelavis/plugin/activate
content-type: application/json
```

Request body:

```json
{
  "pluginName": "search",
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

## Plugin Worker responsibilities

A plugin Worker owns the plugin's isolated runtime surface. It can:

- accept activation requests from Zelavis
- validate the requested plugin version or source
- prepare its own bindings, caches, or metadata
- expose plugin-owned routes through the host's dispatch strategy

The plugin Worker should not need direct access to Node.js APIs, Zelavis internals, or the dashboard React tree.

## Future deploy and upload layer

The Marketplace upload or install flow should eventually call a Cloudflare-specific deploy capability before activation.

That deploy capability is intentionally not in Zelavis core. It belongs in the Cloudflare adapter layer or a Cloudflare management package because it needs Cloudflare account credentials, upload APIs, dispatch namespace configuration, and platform-specific failure handling.

Recommended flow:

1. Marketplace stores plugin registry metadata.
2. Cloudflare deploy capability uploads or updates the plugin Worker.
3. Zelavis calls `activate(...)` on the adapter plugin activation controller.
4. `createCloudflareDispatchPluginActivation(...)` sends the activation request to the dispatched plugin Worker.
5. The plugin Worker returns `active` or `pending`.
6. The dashboard reflects the activation result.

This keeps runtime plugin installs possible without requiring a restart or redeploy of the main Zelavis Worker.

## Related docs

- [Cloudflare Adapter](../adapters/cloudflare.md)
- [Plugin and Service Model](./plugin-service-model.md)
