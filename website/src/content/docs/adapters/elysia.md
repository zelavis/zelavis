---
title: Elysia
---
Use the Elysia utility when Zelavis should be mounted inside an Elysia application.

## Basic usage

```ts
import { Elysia } from "elysia";
import { Zelavis } from "zelavis";
import { bunAdapter } from "zelavis/adapters/bun";
import { elysiaPlugin } from "zelavis/elysia";

const zelavis = new Zelavis({ adapter: bunAdapter() });

new Elysia().use(await elysiaPlugin(zelavis)).listen(3000);
```

## API

```ts
elysiaPlugin(zelavis: Zelavis): Promise<Elysia plugin instance>
```

Returns a promise because the plugin binds to a resolved runtime.

## Good fit

- Elysia apps that want Zelavis as one mounted capability
- Bun-oriented deployments using Elysia as the outer server framework
- Apps that want custom Elysia routes beside the Zelavis runtime

## Related docs

- [Adapter Entry Points](./entry-points.md)
- [First Runtime](../getting-started/first-runtime.md)
- [@zelavis/server](../packages/server.md)
