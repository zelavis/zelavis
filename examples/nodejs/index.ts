import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { nodePlatform } from "zelavis/platforms/node";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const dataDirectory = fileURLToPath(new URL("./.data", import.meta.url));
  const zelavis = new Zelavis({
    adapter: nodeAdapter(),
    platform: nodePlatform({
      dataDirectory,
    }),
    onError: ({ error }) => ({
      status: 400,
      body: { error: error instanceof Error ? error.message : "Unknown error" },
    }),
  });
  const runtime = await zelavis.runtime();
  const server = await zelavis.adapter.nodeServer();

  console.log("database driver", runtime.services.database.service.driver.name);
  console.log("database file", join(dataDirectory, "zelavis.sqlite"));

  server.listen(port, () => {
    console.log(
      `zelavis Node.js example listening on http://localhost:${port}`,
    );
  });
}

await main();
