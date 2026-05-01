import { H3, serve } from "h3";
import { zelavis } from "zelavis";
import { h3Adapter } from "zelavis/adapters/h3";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const app = new H3();

  app.get("/hello", () => "Hello h3");

  const zelavisRuntime = await zelavis({
    onError: ({ error }) => ({
      status: 400,
      body: { error: error instanceof Error ? error.message : "Unknown error" },
    }),
  });

  app.use("/**", h3Adapter(zelavisRuntime));

  serve(app, {
    port,
  });

  console.log(`zelavis h3 example listening on http://localhost:${port}`);
}

void main();
