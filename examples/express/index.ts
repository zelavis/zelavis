import express from "express";
import { Zelavis } from "zelavis";
import { zelavisExpress, zelavisNode } from "zelavis/adapters";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const app = express();

  app.get("/hello", (_request, response) => {
    response.type("text/plain").send("Hello Express");
  });
  app.use(express.json());

  const zelavis = new Zelavis({
    adapter: zelavisExpress({ platform: zelavisNode() }),
    onError: ({ error }) => ({
      status: 400,
      body: { error: error instanceof Error ? error.message : "Unknown error" },
    }),
  });

  app.use(zelavis.adapter.expressMiddleware());
  app.listen(port, () => {
    console.log(
      `zelavis Express example listening on http://localhost:${port}`,
    );
  });
}

await main();
