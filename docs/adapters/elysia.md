# Elysia Adapter

Use the Elysia adapter when Zelavis should be mounted inside an Elysia application.

## Basic usage

```ts
import { Elysia } from "elysia";
import { Zelavis } from "zelavis";
import { zelavisElysia, zelavisBun } from "zelavis/adapters";

const zelavis = new Zelavis({
  adapter: zelavisElysia({ platform: zelavisBun() }),
});

new Elysia().use(await zelavis.adapter.elysiaPlugin()).listen(3000);
```

## Options

```ts
zelavisElysia({
  platform?: ZelavisAdapterPlatform;
})
```

## Good fit

- Elysia apps that want Zelavis as one mounted capability
- Bun-oriented deployments using Elysia as the outer server framework
- Apps that want custom Elysia routes beside the Zelavis runtime

## Notes

- Elysia owns the outer application and lifecycle.
- Zelavis remains runtime-neutral internally and only touches Elysia at the adapter boundary.
- This is a mount helper, not a different Zelavis API surface.

## Related docs

- [Adapter Entry Points](./entry-points.md)
- [First Runtime](../getting-started/first-runtime.md)
- [@zelavis/server](../packages/server.md)
