import Fastify from "fastify";
import { Zelavis } from "zelavis";
import { fastifyAdapter } from "zelavis/adapters/fastify";
import { nodePlatform } from "zelavis/platforms/node";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const app = Fastify();

  app.get("/hello", async () => "Hello Fastify");

  const zelavis = new Zelavis({
    adapter: fastifyAdapter(),
    platform: nodePlatform(),
    onError: ({ error }) => ({
      status: 400,
      body: { error: error instanceof Error ? error.message : "Unknown error" },
    }),
  });

  await app.register(zelavis.adapter.fastifyPlugin());
  await app.listen({
    port,
    host: "127.0.0.1",
  });

  console.log(`zelavis Fastify example listening on http://localhost:${port}`);
}

void main();
