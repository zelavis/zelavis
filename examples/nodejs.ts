import { zelavis } from "zelavis";
import { nodeIntegration } from "zelavis/integrations/node";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);

  const zelavisRuntime = await zelavis({
    integration: nodeIntegration(),
    onError: ({ error }) => ({
      status: 400,
      body: { error: error instanceof Error ? error.message : "Unknown error" },
    }),
  });

  console.log("mounted services", Object.keys(zelavisRuntime.services));
  console.log(
    "database nested service count",
    zelavisRuntime.services.database.services?.length ?? 0,
  );
  console.log("auth service name", zelavisRuntime.services.auth.name);
  console.log(
    "database driver",
    zelavisRuntime.services.database.service.driver.name,
  );
  console.log("dashboard", `GET http://localhost:${port}/zelavis`);
  console.log(
    "list auth providers",
    `GET http://localhost:${port}/zelavis/api/v1/auth/providers`,
  );
  console.log(
    "list database collections",
    `GET http://localhost:${port}/zelavis/api/v1/database/documents/collections`,
  );

  zelavisRuntime.server.listen(port, () => {
    console.log(
      `zelavis Node.js example listening on http://localhost:${port}`,
    );
  });
}

void main();
