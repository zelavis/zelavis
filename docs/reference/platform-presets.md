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
zelavis/platforms/netlify
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

For file storage, Vercel Blob is the natural fit. Zelavis can wrap a Vercel Blob client through `createVercelBlobFileStorage(...)` and use it as the platform file storage resource.

When Zelavis is hosted inside a Next.js App Router route on Vercel, that example does not need a separate Next.js adapter. App Router route handlers are already fetch-native, so `zelavis.fetch(request)` is the direct integration point. The separate `nextjs-pages-router` adapter remains useful for the older Pages Router shape, where Zelavis needs to adapt framework-specific request and response objects.

### `netlifyPlatform()`

Provides a Netlify-shaped platform slot.

Netlify Blobs is a good fit here because Netlify documents it as a store for blobs, unstructured data, and even simple key/value or lightweight database patterns. Zelavis can wrap a Netlify Blobs store through:

- `createNetlifyBlobsKeyValueStore(...)`
- `createNetlifyBlobsFileStorage(...)`

## Platform resources

Each platform preset can contribute runtime resources through `zelavis.platform.resources`:

- `kv`
- `files`

When you use the high-level `Zelavis` class, these resources are not only visible to adapters. Zelavis also uses them as fallback persistence for core services:

- dashboard settings prefer platform KV, then platform files, then in-memory persistence
- the storage core service can expose platform file storage through `/zelavis/api/v1/storage/files/*`
- the storage core service can also expose metadata and file references through `/zelavis/api/v1/storage/files/*?format=metadata`
- website pages can persist to platform file storage when no database core service is configured

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
