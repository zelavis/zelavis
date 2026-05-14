# Platform Adapters

Platform adapters contribute host-level infrastructure defaults to Zelavis: database drivers, KV stores, file storage, and dashboard settings persistence.

They are regular adapters and come from the same `zelavis/adapters` entry point as framework adapters. The distinction is purely functional — platform adapters provide `resolve` logic for infrastructure and have no framework mounting logic.

## Import

```ts
import {
  zelavisNode,
  zelavisBun,
  zelavisCloudflare,
  zelavisVercel,
  zelavisNetlify,
} from "zelavis/adapters";
```

## Available platform adapters

### `zelavisNode(options?)`

Node-oriented defaults:

- `better-sqlite3` database driver
- File-backed dashboard settings store
- In-memory KV store
- Local file storage rooted in the Zelavis data directory

```ts
import { zelavisExpress, zelavisNode } from "zelavis/adapters";

new Zelavis({
  adapter: zelavisExpress({
    platform: zelavisNode({ dataDirectory: ".zelavis" }),
  }),
});
```

### `zelavisBun(options?)`

Bun-oriented defaults:

- Bun SQLite database driver
- File-backed dashboard settings store
- In-memory KV store
- Local file storage rooted in the Zelavis data directory

```ts
import { zelavisBun } from "zelavis/adapters";

const zelavis = new Zelavis({ adapter: zelavisBun() });

export default { fetch: (req) => zelavis.fetch(req) };
```

### `zelavisCloudflare({ env, bindings? })`

Cloudflare-oriented bindings. Pass the Worker `env` object and the platform discovers the standard Zelavis bindings (`ZELAVIS_DB`, `ZELAVIS_KV`, `ZELAVIS_FILES`):

- D1 database driver
- KV namespace as the KV store
- R2 bucket as file storage

```ts
import { zelavisCloudflare } from "zelavis/adapters";

const zelavis = new Zelavis({
  adapter: zelavisCloudflare({ env }),
});

export default {
  async fetch(request, env, ctx) {
    return zelavis.fetch(request, ctx);
  },
};
```

The `env` object is passed at call time. Cloudflare Workers inject bindings at request time, so `zelavisCloudflare({ env })` captures them via closure before the adapter is used.

Custom binding names can be overridden through the `bindings` option.

### `zelavisVercel(options?)`

Vercel-shaped platform slot. Accepts injected database configuration, KV store, and file storage. Does not pick one default Vercel product automatically — you supply the resources explicitly.

For file storage, Vercel Blob is the natural fit via `createVercelBlobFileStorage(...)`.

```ts
import { zelavisVercel } from "zelavis/adapters";

const zelavis = new Zelavis({
  adapter: zelavisVercel({
    files: { blobStore: myVercelBlobClient },
  }),
});

export async function GET(request: Request) {
  return zelavis.fetch(request);
}
```

### `zelavisNetlify(options?)`

Netlify-shaped platform slot. Netlify Blobs is the natural fit for both KV and file storage:

```ts
import { getStore } from "@netlify/blobs";
import { zelavisNetlify } from "zelavis/adapters";

const zelavis = new Zelavis({
  adapter: zelavisNetlify({
    kv: { blobsStore: getStore("zelavis-kv") },
    files: { blobsStore: getStore("zelavis-files") },
  }),
});
```

## Platform resources

Platform adapters contribute runtime resources through `zelavis.platform.resources`:

- `kv` — used for dashboard settings persistence
- `files` — used for file storage and website page persistence

These resources are not Zelavis services. They are host-level infrastructure capabilities. The Zelavis runtime uses them as fallback persistence when no explicit service configuration is provided.

## Generic object storage

S3-compatible object storage is not a platform preset — it is a storage backend. Use the first-party helper:

```ts
import { createS3CompatibleFileStorage } from "zelavis/storage/s3";
```

Pass the result as the `files` resource when constructing your adapter.

## Related docs

- [Adapters and Fetch-Native Hosts](../guides/adapters-and-fetch-native.md)
- [Adapter Entry Points](../adapters/entry-points.md)
