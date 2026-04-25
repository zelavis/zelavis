import Fastify from "fastify";
import { zelavis } from "zelavis";
import { fastifyIntegration } from "zelavis/integrations/fastify";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const app = Fastify();

  app.get("/hello", async () => "Hello Fastify");

  const zelavisRuntime = await zelavis({
    onError: ({ error }) => ({
      status: 400,
      body: { error: error instanceof Error ? error.message : "Unknown error" },
    }),
  });

  await app.register(fastifyIntegration(zelavisRuntime));
  await app.listen({
    port,
    host: "127.0.0.1",
  });

  console.log(`zelavis Fastify example listening on http://localhost:${port}`);
}

void main();
