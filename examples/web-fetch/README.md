This example shows the smallest fetch-native Zelavis embedding.

It does not depend on Node, Express, Hono, or Next-specific APIs. It only exports a standard `fetch(request)` handler.

It is a reference embedding example, not a standalone runnable server demo. To use it, import the handler into a host that already expects a Web-style `fetch` entrypoint.

## What it is for

Use this pattern for platforms that expect a Web-style handler, such as workers, edge runtimes, Bun, Deno, or custom fetch-based hosts.

It also pairs naturally with the storage + file-reference flow:

1. mount Zelavis behind a fetch-native host
2. upload files through `/zelavis/api/v1/storage/files/*`
3. store the returned Zelavis file reference in a database document field validated with `type: "file"`

## Files

- `index.ts` exports a standard fetch handler backed by `zelavis({})`
- `tsconfig.json` validates the example against DOM/Web platform types

## Shape

```ts
import handler from "./index.js";

export default {
  fetch: handler.fetch,
};
```
