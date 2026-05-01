import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBetterSqlite3DatabaseDriver } from "@zelavis/database-node-sqlite";
import { zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const dataDirectory = fileURLToPath(new URL("./.data", import.meta.url));
  const databasePath = join(dataDirectory, "zelavis.sqlite");

  const zelavisRuntime = await zelavis({
    coreServices: {
      database: {
        driver: createBetterSqlite3DatabaseDriver({
          filename: databasePath,
        }),
      },
    },
    onError: ({ error }) => ({
      status: 400,
      body: { error: error instanceof Error ? error.message : "Unknown error" },
    }),
  });
  const server = nodeAdapter(zelavisRuntime);

  console.log(
    "database driver",
    zelavisRuntime.services.database.service.driver.name,
  );
  console.log("database file", databasePath);

  server.listen(port, () => {
    console.log(
      `zelavis Node.js example listening on http://localhost:${port}`,
    );
  });
}

void main();
