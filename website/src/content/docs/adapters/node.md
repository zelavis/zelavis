---
title: Node.js
---
The Node.js adapter has two pieces:

- `nodeAdapter()` from `zelavis/adapters/node` — the environment adapter that provides SQLite, file storage, and Platform System Store persistence.
- `createNodeServer(zv)` from `zelavis/runtimes/node` — a utility that creates a standalone Node HTTP server bound to Zelavis.
- `shutdownOnSignals(shutdown)` from the same subpath — stops the process cleanly on SIGINT, SIGTERM and SIGHUP.

## Basic usage

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { createNodeServer } from "zelavis/runtimes/node";

const zv = new Zelavis({ adapter: nodeAdapter() });
const server = await createNodeServer(zv);
server.listen(3000);
```

## Stopping cleanly

A Platform that runs Projects must finish `zv.close()` before the process ends: that
is what stops the Projects and releases their placements. Register it with
`shutdownOnSignals` rather than `process.once`:

```ts
import { closeNodeServer, shutdownOnSignals } from "zelavis/runtimes/node";

shutdownOnSignals(async () => {
  await Promise.all([closeNodeServer(server), zv.close()]);
});
```

A one-shot handler is removed by the first signal, so a second Ctrl-C (a terminal
and a dev script that forwards it each send one) kills the process in the middle
of the shutdown and leaves the placements active. `shutdownOnSignals` ignores
repeated signals while it runs, also handles a closed terminal (SIGHUP), exits with
the shutdown's result, and cuts off a shutdown that hangs (30 seconds by default,
`forceAfterMs`). A Platform that still did not shut down cleanly (killed outright,
a crash) is taken over on the next start, because the new session fences the old
one.

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
