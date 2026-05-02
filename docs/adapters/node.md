# Node Adapter

Use the Node adapter when Zelavis should own a standalone HTTP server in a Node.js process.

## Basic usage

```ts
import { zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";

const runtime = await zelavis();
const server = nodeAdapter(runtime);

server.listen(3000);
```

## Current use cases

- standalone local development server
- simple self-hosted deployments
- local dashboard development
- file-backed dashboard settings storage
- serving the default website and dashboard together from one Node process

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
