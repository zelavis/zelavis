import { Elysia } from "elysia";
import { Zelavis } from "zelavis";
import { bunAdapter } from "zelavis/adapters/bun";
import { elysiaPlugin } from "zelavis/elysia";

const port = Number(process.env.PORT ?? 3000);

const zv = new Zelavis({
  adapter: bunAdapter(),
  onError: ({ error }) => ({
    status: 400,
    body: { error: error instanceof Error ? error.message : "Unknown error" },
  }),
});

new Elysia()
  .get("/hello", "Hello Elysia")
  .use(await elysiaPlugin(zv))
  .listen(port);

console.log(`zelavis Elysia example listening on http://localhost:${port}`);
