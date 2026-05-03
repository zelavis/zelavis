import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Zelavis } from "zelavis";
import { honoAdapter } from "zelavis/adapters/hono";
import { nodePlatform } from "zelavis/platforms/node";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const app = new Hono();

  app.get("/hello", (context) => {
    return context.text("Hello Hono");
  });

  const zelavis = new Zelavis({
    adapter: honoAdapter(),
    platform: nodePlatform(),
    onError: ({ error }) => ({
      status: 400,
      body: { error: error instanceof Error ? error.message : "Unknown error" },
    }),
  });

  app.use(zelavis.adapter.honoMiddleware());

  serve(
    {
      fetch: app.fetch,
      port,
    },
    () => {
      console.log(`zelavis Hono example listening on http://localhost:${port}`);
    },
  );
}

await main();
