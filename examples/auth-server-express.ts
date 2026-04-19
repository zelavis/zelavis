import express from "express";
import { authService } from "@zelavis/auth";
import { zelavisServer } from "@zelavis/server";
import { expressIntegration } from "@zelavis/server/integrations/express";

async function main(): Promise<void> {
  const app = express();
  const router = express.Router();

  app.use(express.json());

  const zelavisRuntime = await zelavisServer({
    services: [authService()],
    integration: expressIntegration(router),
    version: "v1",
    prefix: "/api/v1",
    servicePrefixes: {
      auth: "/auth",
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
  console.log("auth service name", zelavisRuntime.services.auth.name);

  app.use(router);
  app.listen(3000);
}

void main();
