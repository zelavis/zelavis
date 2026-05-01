import { Elysia } from "elysia";
import { zelavis } from "zelavis";
import { elysiaAdapter } from "zelavis/adapters/elysia";

const port = Number(process.env.PORT ?? 3000);

const zelavisRuntime = await zelavis({
  onError: ({ error }) => ({
    status: 400,
    body: { error: error instanceof Error ? error.message : "Unknown error" },
  }),
});

new Elysia()
  .get("/hello", "Hello Elysia")
  .use(elysiaAdapter(zelavisRuntime))
  .listen(port);

console.log(`zelavis Elysia example listening on http://localhost:${port}`);
