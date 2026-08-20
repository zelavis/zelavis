import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { createNodeServer } from "zelavis/node";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const blueprintsDirectory = process.env.ZELAVIS_BLUEPRINTS_DIR;

  const zv = new Zelavis({
    adapter: nodeAdapter({
      ...(blueprintsDirectory
        ? { blueprints: { directory: blueprintsDirectory } }
        : {}),
    }),
    onError: ({ error }) => ({
      status: 400,
      body: { error: error instanceof Error ? error.message : "Unknown error" },
    }),
  });

  const server = await createNodeServer(zv);

  server.listen(port, () => {
    console.log(
      `zelavis Node.js example listening on http://localhost:${port}`,
    );
  });
}

await main();
