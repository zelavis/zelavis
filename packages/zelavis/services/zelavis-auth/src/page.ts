/**
 * The auth settings page.
 *
 * Served through the service page asset route and rendered in a frame that is
 * same-origin with the Platform, so it calls the same versioned API the
 * dashboard does, with the same session, using plain `fetch`. Nothing here is
 * privileged: every endpoint it touches is one the CLI and any other client
 * can use.
 *
 * It shows three things — how someone signs in today, the OAuth providers
 * configured for this installation, and the plugins that extend auth. The
 * third is a catalogue scoped to one service rather than a general one: a list
 * of everything installable tells nobody which of it is an auth method.
 */
export const AUTH_SETTINGS_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Auth</title>
    <link rel="stylesheet" href="../../../service-page.css" />
    <style>
      .grid { display: grid; gap: 0.75rem; }
      .row {
        display: flex;
        gap: 0.75rem;
        align-items: baseline;
        justify-content: space-between;
        flex-wrap: wrap;
      }
      .name { font-weight: 600; }
      .empty { color: var(--muted-foreground); }
      .error { border-color: var(--destructive); color: var(--destructive); }
      .tag {
        font-size: 0.75rem;
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 0.05rem 0.5rem;
        color: var(--muted-foreground);
      }
      form { display: grid; gap: 0.5rem; }
      .fields { display: flex; gap: 0.5rem; flex-wrap: wrap; }
      input {
        font: inherit;
        flex: 1 1 14rem;
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
          <h2>Sign-in</h2>
          <p class="zv-muted" id="providers-hint">Loading…</p>
        </div>
        <div class="grid" id="providers"></div>
      </section>

      <section class="zv-card zv-stack">
        <div>
          <h2>Single sign-on</h2>
          <p class="zv-muted">
            Paste an OpenID Connect issuer to add a provider. Zelavis reads its
            endpoints from the issuer itself, so nothing has to be installed
            first.
          </p>
        </div>
        <form id="connect">
          <div class="fields">
            <input id="provider" placeholder="name, e.g. acme" aria-label="Provider name" required />
            <input id="issuer" placeholder="https://id.example.com" aria-label="Issuer URL" />
          </div>
          <div class="fields">
            <input id="clientId" placeholder="client id" aria-label="Client id" required />
            <input id="clientSecret" type="password" placeholder="client secret" aria-label="Client secret" />
          </div>
          <div class="fields">
            <input id="redirectUri" placeholder="https://example.com/…/callback" aria-label="Redirect URI" required />
            <button class="zv-button" type="submit">Save</button>
          </div>
        </form>
        <p id="connect-status" class="zv-muted" role="status" hidden></p>
        <div class="grid" id="connections"></div>
      </section>

      <section class="zv-card zv-stack">
        <div>
          <h2>Auth plugins</h2>
          <p class="zv-muted" id="extensions-hint">Loading…</p>
        </div>
        <div class="grid" id="extensions"></div>
      </section>
    </main>

    <script type="module">
      // Four levels up from /runtime/service-page-assets/<service>/<bundle>/<file>
      // is the API root this page was served from.
      const apiRoot = new URL("../../../../", location.href).pathname.replace(/\\/$/, "");
      const OWNER = "zelavis/auth";

      const el = (id) => document.getElementById(id);

      async function api(path, init) {
        const response = await fetch(apiRoot + path, {
          headers: { accept: "application/json", ...(init?.headers ?? {}) },
          ...init,
        });
        const text = await response.text();
        const body = text ? JSON.parse(text) : undefined;
        if (!response.ok) {
          throw new Error(body?.error ?? \`Request failed (\${response.status})\`);
        }
        return body;
      }

      function card(children) {
        const row = document.createElement("div");
        row.className = "zv-card row";
        for (const child of children) row.append(child);
        return row;
      }

      function text(value, className) {
        const span = document.createElement("span");
        if (className) span.className = className;
        span.textContent = value;
        return span;
      }

      async function renderProviders() {
        try {
          const status = await api("/auth/bootstrap");
          el("providers-hint").textContent = status.required
            ? "This installation has no owner yet."
            : "How people sign in to this installation.";
          const list = el("providers");
          list.replaceChildren();
          const names = status.providers ?? [];
          if (names.length === 0) {
            list.append(text("No sign-in method is available.", "empty"));
            return;
          }
          for (const name of names) {
            const enrolls = (status.enrollmentProviders ?? []).includes(name);
            list.append(
              card([
                text(name, "name"),
                text(enrolls ? "creates accounts" : "sign-in only", "tag"),
              ]),
            );
          }
        } catch (cause) {
          el("providers-hint").textContent = cause.message;
          el("providers-hint").classList.add("error");
        }
      }

      async function renderConnections() {
        const list = el("connections");
        list.replaceChildren();
        try {
          const { providers = [] } = await api("/auth/oauth/connections");
          for (const connection of providers) {
            const detail = connection.configured
              ? \`\${connection.clientId}\${connection.hasClientSecret ? " · secret set" : ""}\`
              : "not configured";
            list.append(
              card([
                text(connection.title ?? connection.provider, "name"),
                text(detail, "tag"),
              ]),
            );
          }
        } catch (cause) {
          list.append(text(cause.message, "empty error"));
        }
      }

      async function renderExtensions() {
        const list = el("extensions");
        list.replaceChildren();
        try {
          // Scoped to what extends auth. A general catalogue would list a
          // dashboard theme beside a sign-in method and mean nothing here.
          const { extensionPoints = [] } = await api(
            \`/runtime/extensions?owner=\${encodeURIComponent(OWNER)}\`,
          );
          const point = extensionPoints[0];
          const extensions = point?.extensions ?? [];
          el("extensions-hint").textContent = extensions.length
            ? "Plugins that add sign-in methods to this installation."
            : "No auth plugins are registered on this installation.";
          for (const extension of extensions) {
            const action = document.createElement("button");
            action.className = "zv-button";
            const installed = extension.status === "installed";
            action.textContent = installed ? "Disable" : "Install";
            action.addEventListener("click", async () => {
              action.disabled = true;
              try {
                await api(
                  \`/runtime/services/\${encodeURIComponent(extension.name)}\`,
                  {
                    method: "PATCH",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      status: installed ? "available" : "installed",
                    }),
                  },
                );
                await renderExtensions();
                await renderConnections();
              } catch (cause) {
                action.disabled = false;
                action.textContent = cause.message;
              }
            });
            list.append(
              card([
                text(extension.marketplace?.title ?? extension.name, "name"),
                text(extension.status, "tag"),
                action,
              ]),
            );
          }
        } catch (cause) {
          el("extensions-hint").textContent = cause.message;
          el("extensions-hint").classList.add("error");
        }
      }

      el("connect").addEventListener("submit", async (event) => {
        event.preventDefault();
        const status = el("connect-status");
        status.hidden = false;
        status.classList.remove("error");
        status.textContent = "Saving…";
        try {
          const provider = el("provider").value.trim();
          await api(\`/auth/oauth/connections/\${encodeURIComponent(provider)}\`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...(el("issuer").value.trim()
                ? { issuer: el("issuer").value.trim() }
                : {}),
              clientId: el("clientId").value.trim(),
              // Omitted when blank, which keeps whatever is stored: the API
              // never returns a secret, so there is nothing to type back.
              ...(el("clientSecret").value
                ? { clientSecret: el("clientSecret").value }
                : {}),
              redirectUri: el("redirectUri").value.trim(),
            }),
          });
          status.textContent = \`Saved \${provider}.\`;
          el("clientSecret").value = "";
          await renderConnections();
        } catch (cause) {
          status.textContent = cause.message;
          status.classList.add("error");
        }
      });

      await Promise.all([renderProviders(), renderConnections(), renderExtensions()]);
    </script>
  </body>
</html>
`;
