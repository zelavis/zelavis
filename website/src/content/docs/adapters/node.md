---
title: Node.js
---
The Node.js adapter has two pieces:

- `nodeAdapter()` from `zelavis/adapters/node` — the environment adapter that provides SQLite, file storage, and dashboard settings persistence.
- `createNodeServer(zv)` from `zelavis/node` — a utility that creates a standalone Node HTTP server bound to Zelavis.

## Basic usage

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { createNodeServer } from "zelavis/node";

const zv = new Zelavis({ adapter: nodeAdapter() });
const server = await createNodeServer(zv);
server.listen(3000);
```

## Node adapter options

```ts
nodeAdapter({
  dataDirectory?: string;           // default: ".zelavis"
  database?: false | { /* ... */ };
  dashboard?: false | { /* ... */ };
  services?: false | {
    directory?: string;             // default: ".zelavis/services"
    allowRemote?: boolean;          // default: true
  };
  files?: false | { rootDirectory?: string };
  kv?: false | { kind?: "memory" };
})
```

## Current use cases

- Standalone local development server
- Simple self-hosted deployments
- Local dashboard development
- Serving the dashboard and website from one Node process

## Dashboard settings storage

The Node adapter automatically wires a file-backed dashboard settings store. The helper is also exported if you want it directly:

```ts
import { createFileDashboardSettingsStore } from "zelavis/adapters/node";
```

Use it when you want runtime-editable dashboard settings persisted to disk.

## Runtime service imports

The Node adapter provides a service importer for registry entries with ESM specifiers. It supports:

- package specifiers, resolved by normal Node ESM rules
- absolute, `./`, `../`, and `file:` paths
- `data:` URLs for tests and small experiments
- `http:` and `https:` ESM modules, downloaded into `.zelavis/services` before import

This is the Node-specific implementation of runtime service activation. Zelavis core still only sees an ESM specifier and a standard dynamic import boundary.

```ts
nodeAdapter({
  services: {
    directory: ".zelavis/services",
    allowRemote: true,
  },
});
```

## Related docs

- [Adapter Entry Points](./entry-points.md)
- [First Runtime](../getting-started/first-runtime.md)
- [Dashboard Development](../guides/dashboard-development.md)
