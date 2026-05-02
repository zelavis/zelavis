# Node Adapter

Use the Node adapter when Zelavis should own a standalone HTTP server in a Node.js process.

## Basic usage

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { nodePlatform } from "zelavis/platforms/node";

const zelavis = new Zelavis({
  adapter: nodeAdapter(),
  platform: nodePlatform(),
});
const server = await zelavis.adapter.nodeServer();

server.listen(3000);
```

## Current use cases

- standalone local development server
- simple self-hosted deployments
- local dashboard development
- file-backed dashboard settings storage
- serving the default website and dashboard together from one Node process
- choosing the default Node database/storage story through one platform preset

## Platform preset

The Node platform preset is where Zelavis now chooses host-level defaults such as the built-in Node SQLite driver and file-backed dashboard settings:

```ts
import { nodePlatform } from "zelavis/platforms/node";
```

Use it when you want the framework adapter and the storage/runtime defaults to feel like one Node-shaped setup.

## Dashboard settings storage

The Node adapter exposes a file-backed dashboard settings helper:

```ts
import { createFileDashboardSettingsStore } from "zelavis/adapters/node";
```

Use it when you want runtime-editable dashboard settings persisted to disk.

The helper persists dashboard settings such as theme, pending `rootPath`, and page-builder toggles outside the runtime process.

## Related docs

- [First Runtime](../getting-started/first-runtime.md)
- [zelavis](../packages/zelavis.md)
- [Dashboard Development](../guides/dashboard-development.md)
