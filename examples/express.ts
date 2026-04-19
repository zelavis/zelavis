import express from "express";
import { zelavisServer } from "zelavis";
import { expressIntegration } from "zelavis/integrations/express";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const app = express();
  const router = express.Router();

  app.get("/health", (_request, response) => {
    response.json({ ok: true });
  });
  app.use(express.json());

  const zelavisRuntime = await zelavisServer({
    integration: expressIntegration(router),
    version: "v1",
    prefix: "/api/v1",
    servicePrefixes: {
      auth: "/auth",
      database: "/database",
    },
    pathOverrides: {
      "auth.providers.list": "/methods",
    },
    onError: ({ error }) => ({
      status: 400,
      body: { error: error instanceof Error ? error.message : "Unknown error" },
    }),
  });

  console.log("mounted services", Object.keys(zelavisRuntime.services));
  console.log("existing app route", `GET http://localhost:${port}/health`);
  console.log("list auth providers", `GET http://localhost:${port}/api/v1/auth/methods`);
  console.log(
    "list database collections",
    `GET http://localhost:${port}/api/v1/database/documents/collections`,
  );

  app.use(router);
  app.listen(port, () => {
    console.log(`zelavis Express example listening on http://localhost:${port}`);
  });
}

void main();
