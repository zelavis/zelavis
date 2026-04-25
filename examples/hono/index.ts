import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { zelavis } from "zelavis";
import { honoIntegration } from "zelavis/integrations/hono";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const app = new Hono();

  app.get("/hello", (context) => {
    return context.text("Hello Hono");
  });

  const zelavisRuntime = await zelavis({
    onError: ({ error }) => ({
      status: 400,
      body: { error: error instanceof Error ? error.message : "Unknown error" },
    }),
  });

  honoIntegration(zelavisRuntime, app);
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

void main();
