# Node Adapter

Use the Node adapter when Zelavis should own a standalone HTTP server in a Node.js process.

## Basic usage

```ts
import { Zelavis } from "zelavis";
import { zelavisNodeServer, zelavisNode } from "zelavis/adapters";

const zelavis = new Zelavis({
  adapter: zelavisNodeServer({ platform: zelavisNode() }),
});

const server = await zelavis.adapter.nodeServer();
server.listen(3000);
```

## Options

```ts
zelavisNodeServer({
  platform?: ZelavisAdapterPlatform;
})
```

## Node platform adapter

`zelavisNode()` provides Node-oriented infrastructure defaults: the built-in SQLite driver and file-backed dashboard settings. Use it as the `platform` option whenever the host is a Node.js process.

```ts
zelavisNode({
  dataDirectory?: string;  // default: ".zelavis"
})
```

## Current use cases

- Standalone local development server
- Simple self-hosted deployments
- Local dashboard development
- Serving the dashboard and website from one Node process

## Dashboard settings storage

The Node adapter exposes a file-backed dashboard settings helper:

```ts
import { createFileDashboardSettingsStore } from "zelavis/adapters/node";
```

Use it when you want runtime-editable dashboard settings persisted to disk.

## Related docs

- [Adapter Entry Points](./entry-points.md)
- [First Runtime](../getting-started/first-runtime.md)
- [Dashboard Development](../guides/dashboard-development.md)
