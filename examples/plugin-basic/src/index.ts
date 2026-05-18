import {
  definePlugin,
  defineService,
  type ZelavisPluginSetupContext,
} from "zelavis";

function createPluginPage({
  apiBasePath,
  rootPath,
}: {
  apiBasePath: string;
  rootPath: string;
}) {
  const healthPath = `${apiBasePath}/example-basic/health`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Example Basic Plugin</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
          "Segoe UI", sans-serif;
        background: Canvas;
        color: CanvasText;
      }

      body {
        margin: 0;
        padding: 32px;
      }

      main {
        display: grid;
        gap: 20px;
        max-width: 760px;
      }

      h1,
      p {
        margin: 0;
      }

      .eyebrow {
        color: color-mix(in srgb, CanvasText 58%, transparent);
        font-size: 0.78rem;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }

      .panel {
        display: grid;
        gap: 12px;
        border: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
        border-radius: 8px;
        padding: 18px;
        background: color-mix(in srgb, Canvas 94%, CanvasText 6%);
      }

      code {
        overflow-wrap: anywhere;
        border-radius: 6px;
        background: color-mix(in srgb, CanvasText 9%, transparent);
        padding: 2px 6px;
      }

      a {
        color: LinkText;
      }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Uploaded plugin</p>
      <h1>Example Basic Plugin</h1>
      <p>
        This page is rendered by an uploaded ESM plugin through the Zelavis
        plugin iframe boundary.
      </p>
      <section class="panel">
        <h2>Runtime checks</h2>
        <p>Dashboard root: <code>${rootPath}</code></p>
        <p>Plugin API: <a href="${healthPath}" target="_blank" rel="noreferrer">${healthPath}</a></p>
      </section>
    </main>
  </body>
</html>`;
}

export default definePlugin<ZelavisPluginSetupContext>({
  name: "example-basic",
  version: "0.1.0",
  menu: {
    title: "Example Basic",
    path: "/example-basic",
    pageLabel: "Example Basic",
    page: {
      id: "dashboard",
      title: "Example Basic",
      render(context) {
        return createPluginPage({
          apiBasePath: context.api.basePath,
          rootPath: context.rootPath,
        });
      },
    },
  },
  setup(context) {
    context.addService(
      defineService({
        name: "example-basic",
        basePath: "/example-basic",
        service: {
          message: "Hello from an uploaded Zelavis plugin.",
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
                  plugin: "example-basic",
                  message: "Hello from an uploaded Zelavis plugin.",
                },
              }),
            },
          ],
        },
      }),
    );
  },
});
