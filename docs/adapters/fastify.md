# Fastify Adapter

Use the Fastify adapter when Zelavis should be mounted as a Fastify plugin inside an existing Fastify application.

## Basic usage

```ts
import Fastify from "fastify";
import { Zelavis } from "zelavis";
import { fastifyAdapter } from "zelavis/adapters/fastify";
import { nodePlatform } from "zelavis/platforms/node";

const app = Fastify();
const zelavis = new Zelavis({
  adapter: fastifyAdapter(),
  platform: nodePlatform(),
});

await app.register(zelavis.adapter.fastifyPlugin());
await app.listen({
  port: 3000,
  host: "127.0.0.1",
});
```

## Good fit

- existing Fastify services
- apps that want Fastify plugins and hooks around Zelavis
- self-hosted deployments using one Fastify process

## Notes

- Fastify keeps owning the server lifecycle while Zelavis provides the mounted runtime surface.
- Zelavis routes continue to respect `rootPath`, API prefix, and API version from the runtime config.
- Custom Fastify routes can sit beside Zelavis routes without changing the Zelavis API contracts.

## Related docs

- [Adapter Entry Points](./entry-points.md)
- [First Runtime](../getting-started/first-runtime.md)
- [@zelavis/server](../packages/server.md)
