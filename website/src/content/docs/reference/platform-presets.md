---
title: Platform Adapters
---
Platform adapters contribute host-level infrastructure to Zelavis: database drivers, KV stores, file storage, and dashboard settings persistence. They are the `adapter:` option you pass to `new Zelavis({...})`.

In Zelavis there is only one *kind* of adapter — the environment adapter. There are no "framework adapters" — framework integration is handled by small utility functions like `expressMiddleware(zv)` from `zelavis/express`.

## Import

```ts
// Direct paths
import { nodeAdapter } from "zelavis/adapters/node";
import { bunAdapter } from "zelavis/adapters/bun";
import { cloudflareAdapter } from "zelavis/adapters/cloudflare";
import { vercelAdapter } from "zelavis/adapters/vercel";
import { netlifyAdapter } from "zelavis/adapters/netlify";

// Or via the barrel (with zelavisX aliases)
import {
  zelavisNode,
  zelavisBun,
  zelavisCloudflare,
  zelavisVercel,
  zelavisNetlify,
} from "zelavis/adapters";
```

## Available adapters

### `nodeAdapter(options?)`

Node-oriented defaults:

- `better-sqlite3` database driver
- File-backed dashboard settings store
- In-memory KV store
- Local file storage rooted in the Zelavis data directory

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { createNodeServer } from "zelavis/node";

const zv = new Zelavis({
  adapter: nodeAdapter({ dataDirectory: ".zelavis" }),
});
const server = await createNodeServer(zv);
server.listen(3000);
```

### `bunAdapter(options?)`

Bun-oriented defaults:

- Bun SQLite database driver
- File-backed dashboard settings store
- In-memory KV store
- Local file storage rooted in the Zelavis data directory

```ts
import { Zelavis } from "zelavis";
import { bunAdapter } from "zelavis/adapters/bun";

const zv = new Zelavis({ adapter: bunAdapter() });

export default { fetch: (req) => zv.fetch(req) };
```

### `cloudflareAdapter({ env, bindings? })`

Cloudflare-oriented bindings. Pass the Worker `env` object and the adapter discovers the standard Zelavis bindings (`ZELAVIS_DB`, `ZELAVIS_KV`, `ZELAVIS_FILES`):

- D1 database driver
- KV namespace as the KV store
- R2 bucket as file storage

```ts
import { Zelavis } from "zelavis";
import { cloudflareAdapter } from "zelavis/adapters/cloudflare";

export default {
  async fetch(request, env, ctx) {
    const zv = new Zelavis({ adapter: cloudflareAdapter({ env }) });
    return zv.fetch(request, ctx);
  },
};
```

The `env` object is passed at call time. Cloudflare Workers inject bindings at request time, so `cloudflareAdapter({ env })` captures them via closure.

Custom binding names can be overridden through the `bindings` option.

### `vercelAdapter(options?)`

Vercel-shaped adapter. Accepts injected database configuration, KV store, and file storage. Does not pick one default Vercel product automatically — you supply the resources explicitly.

For file storage, Vercel Blob is the natural fit via `createVercelBlobFileStorage(...)`.

```ts
import { Zelavis } from "zelavis";
import { vercelAdapter } from "zelavis/adapters/vercel";

const zv = new Zelavis({
  adapter: vercelAdapter({
    files: { blobStore: myVercelBlobClient },
  }),
});

export async function GET(request: Request) {
  return zv.fetch(request);
}
```

### `netlifyAdapter(options?)`

Netlify-shaped adapter. Netlify Blobs is the natural fit for both KV and file storage:

```ts
import { getStore } from "@netlify/blobs";
import { Zelavis } from "zelavis";
import { netlifyAdapter } from "zelavis/adapters/netlify";

const zv = new Zelavis({
  adapter: netlifyAdapter({
    kv: { blobsStore: getStore("zelavis-kv") },
    files: { blobsStore: getStore("zelavis-files") },
  }),
});
```

## Platform resources

Adapters contribute runtime resources accessible through `zv.platform.resources`:

- `kv` — used for dashboard settings persistence
- `files` — used for file storage and website page persistence

These resources are not Zelavis services. They are host-level infrastructure capabilities. The Zelavis runtime uses them as fallback persistence when no explicit service configuration is provided.

## Generic object storage

S3-compatible object storage is not an adapter — it is a storage backend. Use the first-party helper:

```ts
import { createS3CompatibleFileStorage } from "zelavis/storage/s3";
```

Pass the result as the `files` resource when constructing your adapter.

## Related docs

- [Adapters Guide](../guides/adapters-and-fetch-native.md)
- [Adapter Entry Points](../adapters/entry-points.md)
