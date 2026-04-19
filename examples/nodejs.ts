import { authService } from "@zelavis/auth";
import { createDatabase, databaseService } from "@zelavis/database";
import { zelavisServer } from "@zelavis/server";
import { nodeIntegration } from "@zelavis/server/integrations/node";

async function main(): Promise<void> {
  const database = await createDatabase({
    defaultTenantId: "demo",
  });

  const zelavisRuntime = await zelavisServer({
    services: [databaseService(database), authService()],
    integration: nodeIntegration(),
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

  zelavisRuntime.server.listen(3000, () => {
    console.log("zelavis Node.js example listening on http://localhost:3000");
  });
}

void main();
