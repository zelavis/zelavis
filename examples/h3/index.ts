import { H3, serve } from "h3";
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { h3Handler } from "zelavis/h3";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const app = new H3();

  app.get("/hello", () => "Hello h3");

  const zelavis = new Zelavis({
    adapter: nodeAdapter(),
    onError: ({ error }) => ({
      status: 400,
      body: { error: error instanceof Error ? error.message : "Unknown error" },
    }),
  });

  app.use("/**", h3Handler(zelavis));

  serve(app, {
    port,
  });

  console.log(`zelavis h3 example listening on http://localhost:${port}`);
}

await main();
