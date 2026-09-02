import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { closeNodeServer, createNodeServer } from "zelavis/runtimes/node";
import { emailPasswordService } from "@zelavis/app-auth-email-password";
import { zelavisUiFrontend } from "@zelavis/ui/frontend";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);

  const zv = new Zelavis({
    // The Platform serves whatever frontend it is given. Remove this and the
    // API is unchanged while the root path says none is installed.
    frontend: zelavisUiFrontend,
    adapter: nodeAdapter({
      dataDirectory: process.env.ZELAVIS_DATA_DIR,
      services: {
        catalog: [
          {
            service: emailPasswordService(),
            specifier: "@zelavis/app-auth-email-password",
            status: "installed",
            source: "official",
            order: 10,
          },
        ],
      },
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

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ??= Promise.all([
      closeNodeServer(server),
      zv.close(),
    ]).then(
      () => undefined,
      (error) => {
        console.error(error);
        process.exitCode = 1;
      },
    );
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

await main();
