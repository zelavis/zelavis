# Node Integration

Use the Node integration when Zelavis should own a standalone HTTP server in a Node.js process.

## Basic usage

```ts
import { zelavis } from "zelavis";
import { nodeIntegration } from "zelavis/integrations/node";

const runtime = await zelavis();
const server = nodeIntegration(runtime);

server.listen(3000);
```

## Current use cases

- standalone local development server
- simple self-hosted deployments
- local dashboard development
- file-backed dashboard settings storage

## Dashboard settings storage

The Node integration exposes a file-backed dashboard settings helper:

```ts
import { createFileDashboardSettingsStore } from "zelavis/integrations/node";
```

Use it when you want runtime-editable dashboard settings persisted to disk.

## Related docs

- [First Runtime](../getting-started/first-runtime.md)
- [zelavis](../packages/zelavis.md)
- [Dashboard Development](../guides/dashboard-development.md)
