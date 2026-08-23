import {
  defineService,
  type ZelavisServiceSetupContext,
} from "zelavis";

export default defineService<ZelavisServiceSetupContext>({
  name: "@zelavis/example-plugin-basic",
  version: "0.1.0",
  menu: {
    title: "Example Basic",
    path: "/example-basic",
    pageLabel: "Example Basic",
    page: {
      id: "dashboard",
      title: "Example Basic",
      file: "dashboard.html",
    },
  },
  setup(context) {
    context.addService({
      name: "@zelavis/example-basic-runtime",
      basePath: "/example-basic",
      service: {
        message: "Hello from an uploaded Zelavis service.",
      },
      api: {
        v1: [
          {
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
          },
        ],
      },
    });
  },
});
