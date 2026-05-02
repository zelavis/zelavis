import { Elysia } from "elysia";
import { Zelavis } from "zelavis";
import { elysiaAdapter } from "zelavis/adapters/elysia";
import { nodePlatform } from "zelavis/platforms/node";

const port = Number(process.env.PORT ?? 3000);

const zelavis = new Zelavis({
  adapter: elysiaAdapter(),
  platform: nodePlatform(),
  onError: ({ error }) => ({
    status: 400,
    body: { error: error instanceof Error ? error.message : "Unknown error" },
  }),
});

new Elysia()
  .get("/hello", "Hello Elysia")
  .use(await zelavis.adapter.elysiaPlugin())
  .listen(port);

console.log(`zelavis Elysia example listening on http://localhost:${port}`);
