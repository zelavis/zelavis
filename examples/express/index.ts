import express from "express";
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { expressMiddleware } from "zelavis/express";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const app = express();

  app.get("/hello", (_request, response) => {
    response.type("text/plain").send("Hello Express");
  });
  app.use(express.json());

  const zv = new Zelavis({
    adapter: nodeAdapter(),
    onError: ({ error }) => ({
      status: 400,
      body: { error: error instanceof Error ? error.message : "Unknown error" },
    }),
  });

  app.use(expressMiddleware(zv));
  app.listen(port, () => {
    console.log(
      `zelavis Express example listening on http://localhost:${port}`,
    );
  });
}

await main();
