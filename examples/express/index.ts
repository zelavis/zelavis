import express from "express";
import { zelavis } from "zelavis";
import { expressIntegration } from "zelavis/integrations/express";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const app = express();
  const router = express.Router();

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

  expressIntegration(zelavisRuntime, router);
  app.use(router);
  app.listen(port, () => {
    console.log(
      `zelavis Express example listening on http://localhost:${port}`,
    );
  });
}

void main();
