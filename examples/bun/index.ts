import { fileURLToPath } from "node:url";
import { createBunSqliteDatabaseDriver } from "@zelavis/database-bun-sqlite";
import { zelavis } from "zelavis";

const port = Number(Bun.env.PORT ?? 3000);
const databasePath = fileURLToPath(
  new URL("./.data/zelavis.sqlite", import.meta.url),
);

const runtime = await zelavis({
  coreServices: {
    database: {
      driver: createBunSqliteDatabaseDriver({
        filename: databasePath,
      }),
    },
  },
  onError: ({ error }) => ({
    status: 400,
    body: { error: error instanceof Error ? error.message : "Unknown error" },
  }),
});

let server: ReturnType<typeof Bun.serve>;
server = Bun.serve({
  port,
  fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/hello") {
      return new Response("Hello Bun");
    }

    if (!url.pathname.startsWith("/zelavis")) {
      return new Response("Not Found", { status: 404 });
    }

    return runtime.fetch(request, {
      platform: {
        bun: {
          server,
        },
      },
    });
  },
});

console.log("database driver", runtime.services.database.service.driver.name);
console.log("database file", databasePath);
console.log(`zelavis Bun example listening on http://localhost:${port}`);
