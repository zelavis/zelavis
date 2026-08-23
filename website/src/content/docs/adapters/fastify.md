---
title: Fastify
---
Use the Fastify utility when Zelavis should be mounted as a Fastify service inside an existing Fastify application.

## Basic usage

```ts
import Fastify from "fastify";
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { fastifyPlugin } from "zelavis/fastify";

const app = Fastify();
const zv = new Zelavis({ adapter: nodeAdapter() });

await app.register(fastifyPlugin(zv));
await app.listen({ port: 3000, host: "127.0.0.1" });
```

## API

```ts
fastifyPlugin(zv: Zelavis): FastifyPluginAsync
```

## Good fit

- Existing Fastify services
- Apps that want Fastify services and hooks around Zelavis
- Self-hosted deployments using one Fastify process

## Notes

- Fastify keeps owning the server lifecycle while Zelavis provides the mounted runtime surface.
- Zelavis routes continue to respect `rootPath`, API prefix, and API version from the runtime config.
- Custom Fastify routes can sit beside Zelavis routes without changing the Zelavis API contracts.

## Related docs

- [Adapter Entry Points](./entry-points.md)
- [First Runtime](../getting-started/first-runtime.md)
- [@zelavis/server](../packages/zelavis/services/server.md)
