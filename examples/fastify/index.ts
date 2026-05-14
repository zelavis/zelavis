import Fastify from "fastify";
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { fastifyPlugin } from "zelavis/fastify";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const app = Fastify();

  app.get("/hello", async () => "Hello Fastify");

  const zelavis = new Zelavis({
    adapter: nodeAdapter(),
    onError: ({ error }) => ({
      status: 400,
      body: { error: error instanceof Error ? error.message : "Unknown error" },
    }),
  });

  await app.register(fastifyPlugin(zelavis));
  await app.listen({
    port,
    host: "127.0.0.1",
  });

  console.log(`zelavis Fastify example listening on http://localhost:${port}`);
}

await main();
