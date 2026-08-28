---
title: Runtime Adapters and Fetch-Native Hosting
---
Zelavis has a focused runtime adapter model:

1. **Runtime adapters** describe the self-hosted JavaScript runtime Zelavis runs
   on. Today that means Node.js and Bun. Deno is planned.

The core request handler remains Web-standard: `zv.fetch(request)` accepts a
standard `Request` and returns a standard `Response`. That keeps the core
portable without making serverless platforms runtime targets.

## Quick examples

### Node.js standalone HTTP server

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { createNodeServer } from "zelavis/runtimes/node";

const zv = new Zelavis({ adapter: nodeAdapter() });
const server = await createNodeServer(zv);
server.listen(3000);
```

### Bun fetch handler

```ts
import { Zelavis } from "zelavis";
import { bunAdapter } from "zelavis/adapters/bun";

const zv = new Zelavis({ adapter: bunAdapter() });

Bun.serve({
  port: 3000,
  fetch(request) {
    return zv.fetch(request);
  },
});
```

## Runtime adapters

| Adapter | Import path | Provides |
|---|---|---|
| Node.js | `zelavis/adapters/node` | better-sqlite3, local files, local service packages |
| Bun | `zelavis/adapters/bun` | bun:sqlite, local files, local service packages |

All adapters are also re-exported from the barrel `zelavis/adapters` under both
their canonical names and `zelavisX` aliases:

```ts
import {
  zelavisNode,
  zelavisBun,
} from "zelavis/adapters";
```

## Host utilities

| Host | Import | Returns |
|---|---|---|
| Node HTTP server | `zelavis/runtimes/node` -> `createNodeServer(zv)` | `Promise<http.Server>` |
| Bun marker | `zelavis/runtimes/bun` | `bun = true` |
| Deno marker | `zelavis/runtimes/deno` | `deno = true` |

Fetch-native hosts can call `zv.fetch(request)` directly.

## SDK bundle surfaces

Browser support means SDK/client code, not running the Platform OS in a browser.
Use `zelavis/sdk/browser` for a browser-safe fetch client and portable
`zelavis/app/db` / `zelavis/app/auth` contracts without importing the
dashboard, runtime host utilities, or local server adapters.

```ts
import { createBrowserZelavisClient } from "zelavis/sdk/browser";

const client = createBrowserZelavisClient({
  baseUrl: "https://example.com",
});

await client.runtime.config();
```

Future browser database adapters such as IndexedDB or SQLite WASM should plug
into the same database driver boundary used by server adapters.

## Why no serverless runtime targets

Zelavis is intended to be the platform the operator owns. It should run on a VPS,
dedicated server, container, local machine, or future Deno-compatible
self-hosted environment. Managed platforms can still be deployment providers for
user websites or optional provider adapters, but they are not places where
the Zelavis runtime itself is expected to live.

## Related docs

- [Adapter Entry Points](../adapters/entry-points.md)
- [Runtime Targets](../reference/runtime-targets.md)
- [First Runtime](../getting-started/first-runtime.md)
