import { H3, serve } from "h3";
import { Zelavis } from "zelavis";
import { zelavisH3, zelavisNode } from "zelavis/adapters";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const app = new H3();

  app.get("/hello", () => "Hello h3");

  const zelavis = new Zelavis({
    adapter: zelavisH3({ platform: zelavisNode() }),
    onError: ({ error }) => ({
      status: 400,
      body: { error: error instanceof Error ? error.message : "Unknown error" },
    }),
  });

  app.use("/**", zelavis.adapter.h3Handler());

  serve(app, {
    port,
  });

  console.log(`zelavis h3 example listening on http://localhost:${port}`);
}

await main();
