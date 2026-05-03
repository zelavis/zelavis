# Adapters and Fetch-Native Hosts

Zelavis has two different outer integration layers:

- framework adapters
- platform presets

And there is one more important possibility:

- no adapter at all

That last case is correct whenever the host already speaks the standard Web `Request` and `Response` model.

## The short rule

Use an adapter when the host gives you framework-specific request and response objects.

Use `zelavis.fetch(request)` directly when the host already gives you a standard Web `Request` and expects a standard Web `Response`.

Use a platform preset when you want Zelavis to pick host-level infrastructure defaults such as database, KV, dashboard settings storage, or file storage.

## Framework adapters

Framework adapters answer:

> How does Zelavis mount into this host framework naturally?

Examples:

- Express middleware
- Fastify plugin
- Hono middleware
- Next.js Pages Router handler

Typical usage:

```ts
import express from "express";
import { Zelavis } from "zelavis";
import { expressAdapter } from "zelavis/adapters/express";
import { nodePlatform } from "zelavis/platforms/node";

const zelavis = new Zelavis({
  adapter: expressAdapter(),
  platform: nodePlatform(),
});

const app = express();
app.use(zelavis.adapter.expressMiddleware());
```

## Fetch-native hosts

Some hosts already expose the Web-standard `Request` and `Response` model directly.

Examples:

- Cloudflare Workers
- Web-standard server runtimes
- Next.js App Router route handlers

In those environments, the cleanest integration is:

```ts
import { Zelavis } from "zelavis";
import { vercelPlatform } from "zelavis/platforms/vercel";

const zelavis = new Zelavis({
  platform: vercelPlatform(),
});

export async function GET(request: Request) {
  return zelavis.fetch(request);
}
```

There is no missing adapter there. The host already matches Zelavis' fetch interface.

## Why Next.js App Router does not need an adapter

This has been the main source of confusion.

Next.js is a framework.
Vercel is a platform.

Those are different decisions.

When Zelavis runs inside a Next.js App Router route on Vercel:

- `vercelPlatform()` is the platform choice
- App Router route handlers are the host shape
- App Router handlers are already fetch-native

So the integration can be:

```ts
new Zelavis({
  platform: vercelPlatform(),
});
```

followed by:

```ts
return zelavis.fetch(request);
```

That does not break the adapter story. It means this host already speaks the native Zelavis runtime contract.

## Why Next.js Pages Router still has an adapter

Pages Router does not expose the same fetch-native shape as App Router.

That older API uses framework-specific request and response objects, so Zelavis needs a bridge:

- `nextjsPagesRouterAdapter()`

That is exactly what framework adapters are for.

## Platform presets

Platform presets answer:

> What storage and host defaults should Zelavis use here?

Examples:

- `nodePlatform()`
- `bunPlatform()`
- `cloudflarePlatform()`
- `netlifyPlatform()`
- `vercelPlatform()`

These do not decide how Express or Next.js mount requests. They decide host-level infrastructure defaults.

## Mental model

Use this split:

- `adapter` = framework mounting shape
- `platform` = host infrastructure defaults
- `fetch()` directly = no adapter needed because the host is already native

## Related docs

- [Adapter Entry Points](../adapters/entry-points.md)
- [Platform Presets](../reference/platform-presets.md)
- [First Runtime](../getting-started/first-runtime.md)
