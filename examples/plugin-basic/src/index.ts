import { zelavis } from "zelavis/sdk";

zelavis.menu.create({
  title: "Example Basic",
  path: "/example-basic",
  pageLabel: "Example Basic",
  page: {
    id: "dashboard",
    title: "Example Basic",
    file: "dashboard.html",
  },
});

zelavis.routes.create({
  id: "example-basic.health",
  method: "GET",
  path: "/health",
  handler: () => ({
    status: 200,
    body: {
      ok: true,
      service: "@zelavis/example-basic-runtime",
      message: "Hello from an uploaded Zelavis service.",
    },
  }),
});
