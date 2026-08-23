---
title: Adapter Entry Points
---
Zelavis has two adapter layers:

1. **Runtime adapters** (`zelavis/adapters/*`) describe the local JavaScript
   runtime Zelavis runs on.
2. **Framework utilities** (`zelavis/<framework>`) wrap `zv.fetch(request)` for
   a specific self-hosted framework server.

## Runtime adapters

Supported runtime adapters:

```txt
zelavis/adapters/node         — Node.js with better-sqlite3, local files, and local service packages
zelavis/adapters/bun          — Bun with bun:sqlite, local files, and local service packages
```

Deno is a planned runtime target.

The `zelavis/adapters` barrel re-exports every adapter under its canonical name
and a `zelavisX` alias:

```ts
import {
  nodeAdapter,
  bunAdapter,
  zelavisNode,
  zelavisBun,
} from "zelavis/adapters";
```

Typical usage:

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";

const zv = new Zelavis({ adapter: nodeAdapter() });
```

## Framework utilities

Framework utilities take a `Zelavis` instance and return whatever shape the
framework expects. They live at `zelavis/<framework>`:

```txt
zelavis/express       — expressMiddleware(zv)
zelavis/hono          — honoMiddleware(zv)
zelavis/fastify       — fastifyPlugin(zv)
zelavis/h3            — h3Handler(zv)
zelavis/elysia        — elysiaPlugin(zv)
zelavis/nextjs/pages  — nextjsPagesRouterHandler(zv, options?)
zelavis/node          — createNodeServer(zv)
```

These are not runtime adapters. The `Zelavis` instance is constructed once with
its runtime adapter, and the utility only adapts request and response handling.

## defineAdapter

To build a custom self-hosted runtime adapter:

```ts
import { defineAdapter } from "zelavis";

const myAdapter = defineAdapter({
  name: "my-host",
  async resolve(_options) {
    return {
      resources: { kv: myStore, files: myStorage },
      metadata: { runtime: "my-host" },
    };
  },
});
```

Adapters may expose service activation through `resources.services`. The
built-in local adapters use the runtime graph: service registry changes are
applied by the running Zelavis process when supported, or by restarting the
process when live activation is unavailable.

## Related docs

- [Adapters Guide](../guides/adapters-and-fetch-native.md)
- [Runtime Targets](../reference/runtime-targets.md)
- [First Runtime](../getting-started/first-runtime.md)
- [@zelavis/server](../packages/zelavis/services/server.md)
