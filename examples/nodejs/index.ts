import { fileURLToPath } from "node:url";
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { createNodeServer } from "zelavis/node";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const dataDirectory = fileURLToPath(new URL("./.data", import.meta.url));

  const zelavis = new Zelavis({
    adapter: nodeAdapter({ dataDirectory }),
    onError: ({ error }) => ({
      status: 400,
      body: { error: error instanceof Error ? error.message : "Unknown error" },
    }),
  });

  const server = await createNodeServer(zelavis);

  server.listen(port, () => {
    console.log(
      `zelavis Node.js example listening on http://localhost:${port}`,
    );
  });
}

await main();
