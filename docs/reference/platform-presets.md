# Platform Presets

Platform presets describe host-level infrastructure defaults for Zelavis.

They are separate from framework adapters.

- framework adapters decide how Zelavis plugs into Express, Fastify, Hono, Next.js Pages Router, and similar framework shapes
- platform presets decide which storage and runtime defaults a host environment should provide

That split matters because the same framework can run on different platforms. For example, Next.js can run on a Node VPS or on Vercel, so `nextjs` is a framework concern while `node` and `vercel` are platform concerns.

## Current platform entry points

```txt
zelavis/platforms/node
zelavis/platforms/bun
zelavis/platforms/cloudflare
zelavis/platforms/vercel
```

## Current behavior

### `nodePlatform()`

Provides a Node-oriented default runtime story:

- `better-sqlite3` database driver
- file-backed dashboard settings store
- in-memory KV store
- local file storage rooted in the Zelavis data directory

### `bunPlatform()`

Provides a Bun-oriented default runtime story:

- Bun SQLite database driver
- file-backed dashboard settings store
- in-memory KV store
- local file storage rooted in the Zelavis data directory

### `cloudflarePlatform()`

Provides Cloudflare-oriented bindings when you pass them in:

- D1 for the database
- KV for key/value storage
- R2 for file storage

This preset does not guess binding names. You pass the Worker bindings explicitly from `env`.

### `vercelPlatform()`

Provides a Vercel-shaped platform slot for the current architecture.

Today it is intentionally lighter than Node or Cloudflare:

- it can carry injected database configuration
- it can carry injected KV and file storage resources
- it does not yet choose one default Vercel database or blob product automatically

That keeps the Vercel story honest until Zelavis has stronger first-party opinions there.

## Platform resources

Each platform preset can contribute runtime resources through `zelavis.platform.resources`:

- `kv`
- `files`

These resources are not framework adapters and they are not Zelavis services. They are host-level infrastructure capabilities that platform presets can provide to the runtime and to adapters.

## Example

```ts
import { Zelavis } from "zelavis";
import { expressAdapter } from "zelavis/adapters/express";
import { nodePlatform } from "zelavis/platforms/node";

const zelavis = new Zelavis({
  adapter: expressAdapter(),
  platform: nodePlatform({
    dataDirectory: ".zelavis",
  }),
});
```

## Design rule

Use a framework adapter when the question is:

- "How does Zelavis mount into this framework?"

Use a platform preset when the question is:

- "What storage and host defaults should Zelavis use in this runtime environment?"
