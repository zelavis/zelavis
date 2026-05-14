import { fileURLToPath } from "node:url";
import { Zelavis } from "zelavis";
import { zelavisBun } from "zelavis/adapters";

const port = Number(Bun.env.PORT ?? 3000);
const dataDirectory = fileURLToPath(new URL("./.data", import.meta.url));

const zelavis = new Zelavis({
  adapter: zelavisBun({
    dataDirectory,
  }),
  onError: ({ error }) => ({
    status: 400,
    body: { error: error instanceof Error ? error.message : "Unknown error" },
  }),
});
const runtime = await zelavis.runtime();

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
console.log("database file", fileURLToPath(new URL("./.data/zelavis.sqlite", import.meta.url)));
console.log(`zelavis Bun example listening on http://localhost:${port}`);
