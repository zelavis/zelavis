import { zelavis } from "zelavis/sdk";

zelavis.plugins.ui.menus.create({
  title: "Example Basic",
  path: "/example-basic",
  pageLabel: "Example Basic",
  page: {
    id: "dashboard",
    title: "Example Basic",
    file: "dashboard.html",
  },
});

zelavis.operations.create({
  resource: "health",
  action: "get",
  spec: { operationId: "getExampleHealth", summary: "Read the example plugin's health" },
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
