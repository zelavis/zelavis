import express from "express";
import { zelavis } from "zelavis";
import { expressAdapter } from "zelavis/adapters/express";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const app = express();

  app.get("/hello", (_request, response) => {
    response.type("text/plain").send("Hello Express");
  });
  app.use(express.json());

  const zelavisRuntime = await zelavis({
    onError: ({ error }) => ({
      status: 400,
      body: { error: error instanceof Error ? error.message : "Unknown error" },
    }),
  });

  app.use(expressAdapter(zelavisRuntime));
  app.listen(port, () => {
    console.log(
      `zelavis Express example listening on http://localhost:${port}`,
    );
  });
}

void main();
