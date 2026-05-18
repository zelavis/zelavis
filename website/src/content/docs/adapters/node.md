---
title: Node.js
---
The Node.js integration has two pieces:

- `nodeAdapter()` from `zelavis/adapters/node` — the environment adapter that provides SQLite, file storage, and dashboard settings persistence.
- `createNodeServer(zelavis)` from `zelavis/node` — a utility that creates a standalone Node HTTP server bound to Zelavis.

## Basic usage

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { createNodeServer } from "zelavis/node";

const zelavis = new Zelavis({ adapter: nodeAdapter() });
const server = await createNodeServer(zelavis);
server.listen(3000);
```

## Node adapter options

```ts
nodeAdapter({
  dataDirectory?: string;           // default: ".zelavis"
  database?: false | { /* ... */ };
  dashboard?: false | { /* ... */ };
  plugins?: false | {
    directory?: string;             // default: ".zelavis/plugins"
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

## Runtime plugin imports

The Node adapter provides a plugin importer for registry entries with ESM specifiers. It supports:

- package specifiers, resolved by normal Node ESM rules
- absolute, `./`, `../`, and `file:` paths
- `data:` URLs for tests and small experiments
- `http:` and `https:` ESM modules, downloaded into `.zelavis/plugins` before import

This is the Node-specific implementation of runtime plugin activation. Zelavis core still only sees an ESM specifier and a standard dynamic import boundary.

```ts
nodeAdapter({
  plugins: {
    directory: ".zelavis/plugins",
    allowRemote: true,
  },
});
```

## Related docs

- [Adapter Entry Points](./entry-points.md)
- [First Runtime](../getting-started/first-runtime.md)
- [Dashboard Development](../guides/dashboard-development.md)
