/**
 * The marketplace page.
 *
 * Served through the service page asset route and rendered in a frame, which
 * is same-origin with the Platform — so it calls the same versioned API the
 * dashboard does, with the same session, using plain `fetch`. There is no
 * privileged channel here: everything this page can do, an installed service's
 * page can do, which is the point of building the marketplace this way.
 *
 * Styling comes from the dashboard's own design tokens over the service page
 * stylesheet, so the page follows the installation's palette without knowing
 * anything about the dashboard's components.
 */
export const MARKETPLACE_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Marketplace</title>
    <link rel="stylesheet" href="../../../service-page.css" />
    <style>
      .grid { display: grid; gap: 0.75rem; }
      .name { font-weight: 600; }
      .actions { display: flex; gap: 0.5rem; align-items: center; }
      .empty { color: var(--muted-foreground); }
      .error {
        border-color: var(--destructive);
        color: var(--destructive);
      }
      form { display: flex; gap: 0.5rem; flex-wrap: wrap; }
      input {
        font: inherit;
        flex: 1 1 18rem;
        padding: 0.375rem 0.625rem;
        border-radius: 0.5rem;
        border: 1px solid var(--border);
        background: var(--background);
        color: var(--foreground);
      }
    </style>
  </head>
  <body>
    <main class="zv-stack">
      <section class="zv-card zv-stack">
        <div>
          <h2>Install from a source</h2>
          <p class="zv-muted" id="acquire-hint">Checking what this installation allows…</p>
        </div>
        <form id="acquire" hidden>
          <input
            id="reference"
            name="reference"
            placeholder="npm:@scope/package@1.2.3"
            aria-label="Package source reference"
            required
          />
          <button class="zv-button" type="submit">Install</button>
        </form>
        <p id="acquire-status" class="zv-muted" role="status" hidden></p>
      </section>

      <section class="zv-stack">
        <h1>Services</h1>
        <div id="services" class="grid" aria-live="polite">
          <p class="empty">Loading…</p>
        </div>
      </section>
    </main>

    <script type="module">
      // The page is served at
      // <api>/runtime/service-page-assets/<service>/<bundle>/<file>, so the API
      // root is four segments up. Derived rather than hardcoded, because the
      // dashboard's root path is configurable.
      const apiRoot = new URL("../../../../", location.href).pathname.replace(/\\/$/, "");

      const servicesEl = document.getElementById("services");
      const statusEl = document.getElementById("acquire-status");
      const formEl = document.getElementById("acquire");
      const hintEl = document.getElementById("acquire-hint");

      async function api(path, init) {
        // Same-origin, so the session cookie goes along on its own.
        const response = await fetch(apiRoot + path, {
          headers: { accept: "application/json" },
          ...init,
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(body.error || \`Request failed (\${response.status}).\`);
        }
        return body;
      }

      function card(service) {
        const element = document.createElement("div");
        element.className = "zv-card zv-row";

        const left = document.createElement("div");
        const name = document.createElement("div");
        name.className = "name";
        name.textContent = service.marketplace?.title || service.name;
        const detail = document.createElement("div");
        detail.className = "zv-muted";
        detail.textContent =
          service.marketplace?.summary ||
          [service.name, service.version].filter(Boolean).join(" · ");
        left.append(name, detail);

        const right = document.createElement("div");
        right.className = "actions";
        const badge = document.createElement("span");
        badge.className = "zv-badge";
        badge.textContent = service.status;
        right.append(badge);

        element.append(left, right);
        return element;
      }

      function fail(message) {
        servicesEl.replaceChildren();
        const element = document.createElement("div");
        element.className = "zv-card error";
        element.textContent = message;
        servicesEl.append(element);
      }

      async function refresh() {
        try {
          const { services = [] } = await api("/runtime/services");
          servicesEl.replaceChildren();

          if (services.length === 0) {
            const empty = document.createElement("p");
            empty.className = "empty";
            empty.textContent = "No services are registered yet.";
            servicesEl.append(empty);
            return;
          }

          for (const service of services) {
            servicesEl.append(card(service));
          }
        } catch (error) {
          fail(error.message);
        }
      }

      async function detectAcquisition() {
        try {
          const config = await api("/runtime/config");
          const capabilities = config.serviceActivation?.capabilities ?? {};

          if (capabilities.supportsPackageAcquisition) {
            formEl.hidden = false;
            hintEl.textContent =
              "Reference a package as npm:<name>@<version>, or an archive URL this installation trusts.";
          } else {
            // Distinguishing "cannot" from "not configured" is the operator's
            // problem to fix, so say which one it is.
            hintEl.textContent =
              "This installation has no trusted package sources configured, so packages cannot be installed from a remote source.";
          }
        } catch (error) {
          hintEl.textContent = error.message;
        }
      }

      formEl.addEventListener("submit", async (event) => {
        event.preventDefault();
        const reference = document.getElementById("reference").value.trim();
        if (!reference) return;

        const button = formEl.querySelector("button");
        button.disabled = true;
        statusEl.hidden = false;
        statusEl.textContent = \`Installing \${reference}…\`;

        try {
          await api("/runtime/services", {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
            },
            body: JSON.stringify({ packageSource: reference }),
          });
          statusEl.textContent = \`Installed \${reference}.\`;
          document.getElementById("reference").value = "";
          await refresh();
        } catch (error) {
          statusEl.textContent = error.message;
        } finally {
          button.disabled = false;
        }
      });

      await detectAcquisition();
      await refresh();
    </script>
  </body>
</html>
`;
