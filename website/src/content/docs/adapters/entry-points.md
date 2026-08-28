---
title: Adapter Entry Points
---
Zelavis has one public adapter layer in the main package:

1. **Runtime adapters** (`zelavis/adapters/*`) describe the local JavaScript
   runtime Zelavis runs on and provide Platform OS resources.

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

## Host utilities

The main package ships the standalone Node HTTP host utility:

```txt
zelavis/runtimes/node          — createNodeServer(zv)
zelavis/runtimes/bun           — bun marker
zelavis/runtimes/deno          — deno marker
```

Fetch-native hosts can call `zv.fetch(request)` directly. Framework-specific
mounting helpers are not part of the main Platform OS package surface.
Runtime host utilities are intentionally split into separate subpaths so
bundlers can omit code for runtimes that are not imported.

## SDK entry points

SDK entry points are client bundle surfaces, not runtime adapters:

```txt
zelavis/sdk                  — fetch-native SDK core
zelavis/sdk/browser          — browser SDK surface
zelavis/sdk/node             — Node SDK surface using native fetch
```

They intentionally exclude the dashboard, runtime host utilities, and local
server adapters. Browser storage adapters such as IndexedDB and SQLite WASM
should live behind the app database driver boundary rather than in
`zelavis/adapters/*`, because they are SDK/client storage surfaces, not
Platform OS host runtimes.

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
- [zelavis/core](../packages/zelavis/src/core.md)
