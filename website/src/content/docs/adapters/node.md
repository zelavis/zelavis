---
title: Node.js
---
The Node.js adapter has two pieces:

- `nodeAdapter()` from `zelavis/adapters/node` — the environment adapter that provides SQLite, file storage, and dashboard settings persistence.
- `createNodeServer(zv)` from `zelavis/runtimes/node` — a utility that creates a standalone Node HTTP server bound to Zelavis.

## Basic usage

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { createNodeServer } from "zelavis/runtimes/node";

const zv = new Zelavis({ adapter: nodeAdapter() });
const server = await createNodeServer(zv);
server.listen(3000);
```

## Node adapter options

```ts
nodeAdapter({
  dataDirectory?: string;           // default: ".zelavis"
  database?: false | { /* ... */ };
  systemStore?: false | { filename?: string };
  projects?: false | { /* ... */ };
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

The Node adapter automatically wires the Platform System Store. Runtime-editable
dashboard settings persist there by default, separate from project databases.

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
