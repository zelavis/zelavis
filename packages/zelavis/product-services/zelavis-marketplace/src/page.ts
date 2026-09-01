/**
 * The marketplace's placeholder page.
 *
 * A module rather than a file on disk: the service ships inside the Platform
 * and is served through the service page asset route, so there is no package
 * archive to read from and no runtime filesystem access to depend on.
 */
export const MARKETPLACE_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Marketplace</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        padding: 2rem;
        font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
        background: transparent;
        color: CanvasText;
      }
      h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
      p { margin: 0 0 1rem; opacity: 0.75; max-width: 42rem; }
      ul { margin: 0; padding-left: 1.1rem; opacity: 0.75; }
      li { margin-bottom: 0.35rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>Marketplace</h1>
      <p>
        This page is served by the marketplace service itself, through the
        service page asset route. It is a placeholder while package acquisition
        is built.
      </p>
      <p>Installing from a source will cover:</p>
      <ul>
        <li>Frontends &mdash; static sites and applications with their own server</li>
        <li>Plugins and services for a Project</li>
        <li>Apps, starters, and templates for the installation</li>
        <li>Server provider plugins</li>
      </ul>
    </main>
  </body>
</html>
`;
