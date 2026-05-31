import { Zelavis } from "zelavis";
import { bunAdapter } from "zelavis/adapters/bun";

const port = Number(Bun.env.PORT ?? 3000);

const zv = new Zelavis({
  adapter: bunAdapter(),
  onError: ({ error }) => ({
    status: 400,
    body: { error: error instanceof Error ? error.message : "Unknown error" },
  }),
});

const runtime = await zv.runtime();

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
console.log(`zelavis Bun example listening on http://localhost:${port}`);
