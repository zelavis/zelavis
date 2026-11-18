---
title: "@zelavis/ui"
---
`@zelavis/ui` is the dashboard SPA mounted by the Zelavis runtime.

It uses React Router v8 in SPA mode and is served under the configured
dashboard root path, `/zelavis` by default. The dashboard opens to the Projects
overview; project-local pages live under `/zelavis/projects/:projectId/*`.

This is the only Zelavis dashboard application in an installation. Isolated
Zelavis App runtimes do not mount `@zelavis/ui`. The Platform shell keeps its own route
and asset bundle while reading each selected project's APIs and service menu
metadata through the control-plane proxy.

## Current Role

- dashboard shell and slide-based sidebar navigation
- Projects overview and project-local dashboard routes
- global management areas such as Marketplace, Domains, Resources, Server, and
  Security
- mobile-slot-ready route surfaces for future mobile browser and Capacitor
  shells
- service-owned dashboard navigation rendered from runtime menu metadata
- one shared Platform shell for global and project-local views

The dashboard is a client of Zelavis endpoints. Privileged behavior should live
behind runtime capabilities and versioned endpoints, not only inside React route
modules or component callbacks.

## Your account

In the Platform dashboard, open **Account → Account overview**. On an App site,
open its sign-in page while signed in and choose **Manage account**. App
frontends can also link directly to `/zelavis/account` on their own origin.

- **Passkeys** lists your passkeys and lets you rename them. Adding a passkey
  requires an existing passkey, and removal requires a different one. Use a
  browser that supports WebAuthn on the configured relying-party origin.
- **Two-factor authentication** lets you scan the setup QR code or enter the
  setup key, then confirm with a code from your authenticator. Save the backup
  codes when they appear. Each code works once. Generating new codes replaces
  the previous set.
- **Email addresses** lists verified addresses and marks the primary one. When
  you add an address or change the primary one, open the verification link in
  the tab that requested it. Changing the primary address requires your
  current password.
- **Password** changes your password after you enter your current one. The
  change signs out your other sessions.
- **Sessions** marks your current session. You can revoke an individual
  session, revoke all other sessions, or sign out of the current one.

## Database navigation

Project **Backend → Database** lists registered tables across Tenants. Each link
retains the table's Tenant; internal logical views are grouped under **System
Tables**. Creation revalidates the server catalogue, so tables remain visible
after reload. Managed apps use the same navigation for their bound Zelavis
backend once its Database API has been used. Their application's own database
remains separate.

**Server → Logs** (`/zelavis/server/logs`) shows the Platform's recent log, newest first,
and can filter by level or by the reference shown with an "Action failed" message, which
leads to the cause that the generic message hides. It reads `GET /zelavis/api/v1/runtime/logs`
(`client.logs.read`, `zelavis logs`) and needs `server.logs.read` in system scope. Entries are
kept in memory only and a restart empties them; Project logs stay in each Project.

**Server → Access → API keys** creates, rotates and revokes keys for scripts, CI, agents and debugging
sessions. A key is a service account with a token shown once. Presets: **Debug (read-only)** (logs,
processes, nodes, updates, Projects), **Operator** (that plus updates, services, settings, nodes, Edge,
cloud and Project lifecycle; never the terminal, users or deletion) and **Project client**. They call
`/zelavis/api/v1/auth/service-accounts` (`client.auth.admin`, `zelavis auth service-accounts`).

**Server → Terminal** (`/zelavis/server/terminal`) opens a shell on the server inside the
browser (xterm.js) for principals with `server.terminal.use` in system scope, normally the owner.
The shell runs in tmux as the unprivileged account the Platform runs as, so closing the page
leaves it running and the next visit, or `zelavis terminal attach`, picks it up again. On a
server without tmux the page offers to install it through the audited host package operation.

The outer Platform has its own **Server → Database** view at
`/zelavis/server/database`. It inspects the System Store's logical namespace
tables and paginated records, independently of the physical database engine.
This view is read-only and redacts credentials, session authority and secrets.
It requires `server.database.inspect` in system scope; Project grants do not
permit inspection of Platform state.

The same operations are available as `client.runtime.systemStore.namespaces()`
and `client.runtime.systemStore.records(namespace, { limit, after })`,
`GET /zelavis/api/v1/runtime/system-store/namespaces` and
`GET /zelavis/api/v1/runtime/system-store/namespaces/:namespace/records`, and
`zelavis system-store namespaces|records`. Records default to 50 per page,
accept limits from 1 to 200, and return an optional `next` key for `after`.

## Development

Use the mounted development flow from the repository root:

```bash
pnpm dev
```

That starts the runtime and UI dev server together so `/zelavis` behaves like
the mounted dashboard.

For package-only checks:

```bash
pnpm --filter @zelavis/ui typecheck
pnpm --filter @zelavis/ui build
```

## Related Docs

- [Dashboard Development](../guides/dashboard-development.md)
- [Mobile-Slot-Ready Dashboard](../architecture/mobile-slot-ready-dashboard.md)
- [Route Conventions](../reference/route-conventions.md)
