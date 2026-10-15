# Routes

The dashboard serves every route in [`app/dashboard-routes.ts`](../app/dashboard-routes.ts) natively. `scripts/test-route-parity.mjs` visits each one (and the nested Fabric sections, the Project Database and `/projects?new=1`) at a desktop and a mobile size, with no page error and with content drawn, then exercises representative actions: first-owner setup, sign in and out with a return link, creating and renaming a Project, a table, a content type, an entry (including rich text and a reference), a workload (create, run, save, Back), a file upload, the theme and the update banner.

Run it with `pnpm run ci:ui` from the repository root. Set `PARITY_SHOTS=<directory>` to also save a screenshot of the main pages, which is how layout and styling are checked by eye.

| Area | Routes |
|---|---|
| Account | `/login`, `/setup`, `/logout` |
| Platform | `/`, `/projects`, `/marketplace`, `/services`, `/assistant`, `/settings`, `/settings/appearance` |
| Server | `/server`, `/server/resources`, `/server/security`, `/server/runtimes`, `/server/domains`, `/server/access` (+ `/users`, `/permissions`), `/server/backups`, `/server/logs`, `/server/terminal`, `/server/database`, `/server/fabric` (+ section and detail) |
| Project | `/projects/:projectId` (+ `/backend`, `/extensions`, `/agents`, `/settings`, `/frontend`, `/auth`, `/users`, `/storage`, `/media`, `/marketplace`, `/database`, `/database/new`) |
| Content Studio | `/projects/:projectId/content` (+ `/new`, `/:contentType`, `/:contentType/fields`, `/:contentType/:entryId`) |
| Workloads | `/projects/:projectId/workloads` (+ `/functions`, `/jobs`, `/schedules`, `/webhooks`, `/new`, `/logs`, `/settings`, `/:workloadKind/:workloadId`) |
| Managed apps | `/projects/:projectId/:managedSection` (domains, files, app-database, setup, backups, logs, updates, admin) and service-owned pages |

Known gaps against the original React dashboard, to be built here when they matter: saved grid views and column pinning in the database workspace, charts on the Resources page (the Platform reports no host metrics yet, so the page says so rather than inventing numbers).
