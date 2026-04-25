import { zelavis } from "zelavis";
import { nodeIntegration } from "zelavis/integrations/node";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);

  const zelavisRuntime = await zelavis({
    onError: ({ error }) => ({
      status: 400,
      body: { error: error instanceof Error ? error.message : "Unknown error" },
    }),
  });
  const server = nodeIntegration(zelavisRuntime);

  server.listen(port, () => {
    console.log(
      `zelavis Node.js example listening on http://localhost:${port}`,
    );
  });
}

void main();
