import express from "express";
import { authService } from "@zelavis/auth";
import { createDatabase, databaseService } from "@zelavis/database";
import { zelavisServer } from "@zelavis/server";
import { expressIntegration } from "@zelavis/server/integrations/express";

async function main(): Promise<void> {
  const app = express();
  const router = express.Router();
  const database = await createDatabase({
    defaultTenantId: "demo",
  });

  app.use(express.json());

  const zelavisRuntime = await zelavisServer({
    services: [databaseService(database), authService()],
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
  console.log("database nested service count", zelavisRuntime.services.database.services?.length ?? 0);
  console.log("auth service name", zelavisRuntime.services.auth.name);
  console.log("database driver", zelavisRuntime.services.database.service.driver.name);
  console.log("list auth providers", "GET http://localhost:3000/api/v1/auth/methods");
  console.log("list database collections", "GET http://localhost:3000/api/v1/database/documents/collections");

  app.use(router);
  app.listen(3000, () => {
    console.log("zelavis Node.js example listening on http://localhost:3000");
  });
}

void main();
