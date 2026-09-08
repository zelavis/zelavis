/**
 * The marketplace page.
 *
 * Served through the service page asset route and rendered in a frame, which
 * is same-origin with the Platform — so it calls the same versioned API the
 * dashboard does, with the same session, using plain `fetch`. There is no
 * privileged channel here: everything this page can do, an installed service's
 * page can do, which is the point of building the marketplace this way.
 *
 * It composes the Platform's service page elements rather than its own markup.
 * That is the difference between this and the placeholder it replaces: the
 * page describes what it shows — a section, a card, a title with a detail
 * line, a badge — and the design system decides how those look. A frontend
 * that supplies its own element library restyles this page without it
 * changing, and a service that wants to look like the marketplace writes the
 * same tags rather than copying its CSS.
 *
 * The frame stays. Shadow DOM scopes styles, not scripts, and rendering an
 * installed service's page inside the dashboard's document would give its code
 * the dashboard's origin and its session. The frame is the isolation boundary;
 * the elements are how a page inside it stops looking like a placeholder.
 */
export const MARKETPLACE_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Marketplace</title>
    <link rel="stylesheet" href="../../../service-page.css" />
    <script type="module" src="../../../service-elements.js"></script>
    <style>
      /* Layout between components is the page's business; how a component
         looks is not, which is why there is so little here. */
      form { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: end; }
      [data-filter] { max-width: 20rem; }
    </style>
  </head>
  <body>
    <zv-page heading="Marketplace" description="Services this installation knows about, and packages it can install.">
      <zv-section
        heading="Install from a source"
        description="A package is acquired through the sources this installation trusts."
      >
        <zv-card>
          <zv-stack>
            <zv-status id="acquire-hint">Checking what this installation allows…</zv-status>
            <form id="acquire" hidden>
              <zv-field
                id="reference"
                label="Package source"
                placeholder="npm:@scope/package@1.2.3"
                required
              ></zv-field>
              <zv-button id="install" type="submit">Install</zv-button>
            </form>
            <zv-status id="acquire-status"></zv-status>
          </zv-stack>
        </zv-card>
      </zv-section>

      <zv-section id="services-section" heading="Services">
        <zv-field
          data-filter
          id="filter"
          label="Filter"
          placeholder="Name or status"
        ></zv-field>
        <zv-stack id="services" aria-live="polite">
          <zv-empty>Loading…</zv-empty>
        </zv-stack>
      </zv-section>
    </zv-page>

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
      const referenceEl = document.getElementById("reference");
      const installEl = document.getElementById("install");
      const filterEl = document.getElementById("filter");
      const sectionEl = document.getElementById("services-section");

      let services = [];

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
        const card = document.createElement("zv-card");
        const row = document.createElement("zv-row");

        const title = document.createElement("zv-title");
        title.textContent = service.marketplace?.title || service.name;
        const detail =
          service.marketplace?.summary ||
          [service.name, service.version].filter(Boolean).join(" · ");
        if (detail) title.setAttribute("detail", detail);

        const badge = document.createElement("zv-badge");
        badge.textContent = service.status;
        if (service.status === "installed" || service.status === "active") {
          badge.setAttribute("tone", "active");
        }

        row.append(title, badge);
        card.append(row);
        return card;
      }

      function message(text, tone) {
        const empty = document.createElement("zv-empty");
        empty.textContent = text;
        if (tone) empty.setAttribute("tone", tone);
        return empty;
      }

      function paint() {
        const needle = filterEl.value.trim().toLowerCase();
        const matching = needle
          ? services.filter((service) =>
              [service.name, service.status, service.marketplace?.title]
                .filter(Boolean)
                .some((value) => value.toLowerCase().includes(needle)),
            )
          : services;

        sectionEl.setAttribute(
          "description",
          matching.length === services.length
            ? \`\${services.length} registered\`
            : \`\${matching.length} of \${services.length} registered\`,
        );

        servicesEl.replaceChildren(
          ...(matching.length === 0
            ? [
                message(
                  services.length === 0
                    ? "No services are registered yet."
                    : "Nothing matches that filter.",
                ),
              ]
            : matching.map(card)),
        );
      }

      async function refresh() {
        try {
          const body = await api("/runtime/services");
          services = body.services ?? [];
          paint();
        } catch (error) {
          servicesEl.replaceChildren(message(error.message, "danger"));
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
          hintEl.setAttribute("tone", "danger");
        }
      }

      filterEl.addEventListener("input", paint);

      formEl.addEventListener("submit", async (event) => {
        event.preventDefault();
        const reference = referenceEl.value.trim();
        if (!reference) return;

        installEl.setAttribute("busy", "");
        statusEl.removeAttribute("tone");
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
          referenceEl.value = "";
          await refresh();
        } catch (error) {
          statusEl.textContent = error.message;
          statusEl.setAttribute("tone", "danger");
        } finally {
          installEl.removeAttribute("busy");
        }
      });

      await detectAcquisition();
      await refresh();
    </script>
  </body>
</html>
`;
