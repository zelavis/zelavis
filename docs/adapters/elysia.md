# Elysia Adapter

Use the Elysia adapter when Zelavis should be mounted inside an Elysia application.

## Basic usage

```ts
import { Elysia } from "elysia";
import { zelavis } from "zelavis";
import { elysiaAdapter } from "zelavis/adapters/elysia";

const runtime = await zelavis();

new Elysia().use(elysiaAdapter(runtime)).listen(3000);
```

## Good fit

- Elysia apps that want Zelavis as one mounted capability
- Bun-oriented deployments using Elysia as the outer server framework
- apps that want custom Elysia routes beside the Zelavis runtime

## Notes

- Elysia owns the outer application and lifecycle.
- Zelavis remains runtime-neutral internally and only touches Elysia at the adapter boundary.
- This is a mount helper, not a different Zelavis API surface.

## Related docs

- [Adapter Entry Points](./entry-points.md)
- [First Runtime](../getting-started/first-runtime.md)
- [@zelavis/server](../packages/server.md)
