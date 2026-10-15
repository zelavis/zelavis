# Dashboard route parity

The inventory contains 56 legacy route modules. Generated source: `src/workspace-route-manifest.ts`; drift check: `node scripts/audit-routes.mjs --check`. Only new-ui was changed; original route modules are imported without modifying the React dashboard or Platform.

## Verification

`node scripts/test-route-parity.mjs` starts a disposable real Platform, completes its owner wizard, creates an App project, and traverses every page pattern at 1440×1000 and 390×844. It additionally traverses nested Fabric sections/details and the full database workspace. Setup, logout and relation resource routes have dedicated behavioral tests rather than ordinary page checks. It checks browser errors and dedicated content; a page load is not a claim that every possible action or data shape has been exercised.

Real mutation checks cover the Projects create form, table creation and tenant-correct redirect, content type/schema creation, entry editing/save/reload, relation picker loading/saving under the exact Project proxy, workload creation/run/update, theme persistence, logout/login with protected deep-link return, browser Back, and editor/frame identity through footer switches. The native grid and embedded/dev suites separately cover all three adapters, optimistic save conflicts/retry, native schema activation, typed edits, draft reload recovery and sandboxed service grants.

Managed recipe sections are qualified with read-only managed metadata fixtures on both viewport sizes; they do not provision WordPress, host packages, servers or cloud capacity. Original planned controls remain planned. AI provider responses, real cloud provisioning, external deployment, arbitrary marketplace acquisition and host-level operations require their own integration environments; route restoration is not evidence of successful external side effects.

## Rendering

The outer shell, canonical URL and history, Swiper navigation and native database remain Fuzor. Original feature routes run in same-origin first-party React islands using a memory router. CSS, overlays and editors stay within the workspace document. The memory router uses the same /zelavis basename, so links also work when opened in another tab. Project hosting setup uses Platform setup/audit APIs and cannot be mistaken for the owner wizard. The source/origin-authenticated bridge strips sidebar/footer presentation keys in both directions; ordinary query changes retain the frame. Relations always identify a real Project. Extensions continue using the native SDK service-page broker where mounted by new-ui. No claim is made that React workspaces have become native precompiled or resumable Fuzor components.

## Complete original manifest

| Path | Original module | Rendering |
|---|---|---|
| `/` | `routes/projects.index.tsx` | Original feature route island |
| `/login` | `routes/login.tsx` | Original feature route island |
| `/setup` | `routes/setup.tsx` | Original feature route island |
| `/logout` | `routes/logout.tsx` | Original feature route island |
| `/assistant` | `routes/assistant.tsx` | Original feature route island |
| `/projects` | `routes/projects.tsx` | Original feature route island |
| `/services` | `routes/services.tsx` | Original feature route island |
| `/marketplace` | `routes/marketplace.tsx` | Original feature route island |
| `/server` | `routes/server.tsx` | Original feature route island |
| `/server/resources` | `routes/resources.tsx` | Original feature route island |
| `/server/security` | `routes/security.tsx` | Original feature route island |
| `/server/runtimes` | `routes/server.runtimes.tsx` | Original feature route island |
| `/server/domains` | `routes/server.domains.tsx` | Original feature route island |
| `/server/access` | `routes/server.access.tsx` | Original feature route island |
| `/server/access/users` | `routes/server.access.users.tsx` | Original feature route island |
| `/server/access/permissions` | `routes/server.access.permissions.tsx` | Original feature route island |
| `/server/backups` | `routes/server.backups.tsx` | Original feature route island |
| `/server/logs` | `routes/server.logs.tsx` | Original feature route island |
| `/server/database` | `routes/server.database.tsx` | Original feature route island |
| `/server/fabric` | `routes/server.fabric.tsx` | Original feature route island |
| `/server/fabric/:fabricSection` | `routes/server.fabric.$fabricSection.tsx` | Original feature route island |
| `/server/fabric/:fabricSection/:fabricDetail` | `routes/server.fabric.$fabricSection.$fabricDetail.tsx` | Original feature route island |
| `/settings` | `routes/settings.tsx` | Original feature route island |
| `/settings/appearance` | `routes/settings.appearance.tsx` | Original feature route island |
| `/projects/:projectId` | `routes/index.tsx` | Original feature route island |
| `/projects/:projectId/backend` | `routes/backend.tsx` | Original feature route island |
| `/projects/:projectId/extensions` | `routes/extensions.tsx` | Original feature route island |
| `/projects/:projectId/marketplace` | `routes/project.marketplace.tsx` | Original feature route island |
| `/projects/:projectId/agents` | `routes/agents.tsx` | Original feature route island |
| `/projects/:projectId/auth` | `routes/auth.tsx` | Original feature route island |
| `/projects/:projectId/content` | `routes/content.tsx` | Original feature route island |
| `/projects/:projectId/content/new` | `routes/content.new.tsx` | Original feature route island |
| `/projects/:projectId/content/:contentType` | `routes/content.$contentType.tsx` | Original feature route island |
| `/projects/:projectId/content/:contentType` | `routes/content.$contentType.index.tsx` | Original feature route island |
| `/projects/:projectId/content/:contentType/fields` | `routes/content.$contentType.fields.tsx` | Original feature route island |
| `/projects/:projectId/content/:contentType/:entryId` | `routes/content.$contentType.$entryId.tsx` | Original feature route island |
| `/projects/:projectId/database` | `routes/database.tsx` | Native Fuzor SSR; original workspace via `workspaceMode=full` |
| `/projects/:projectId/database/new` | `routes/database.new.tsx` | Original feature route island |
| `/projects/:projectId/media` | `routes/media.tsx` | Original feature route island |
| `/projects/:projectId/settings` | `routes/project.settings.tsx` | Original feature route island |
| `/projects/:projectId/storage` | `routes/storage.tsx` | Original feature route island |
| `/projects/:projectId/users` | `routes/users.tsx` | Original feature route island |
| `/projects/:projectId/frontend` | `routes/frontend.tsx` | Original feature route island |
| `/projects/:projectId/workloads` | `routes/workloads.tsx` | Original feature route island |
| `/projects/:projectId/workloads/functions` | `routes/workloads.functions.tsx` | Original feature route island |
| `/projects/:projectId/workloads/jobs` | `routes/workloads.jobs.tsx` | Original feature route island |
| `/projects/:projectId/workloads/schedules` | `routes/workloads.schedules.tsx` | Original feature route island |
| `/projects/:projectId/workloads/webhooks` | `routes/workloads.webhooks.tsx` | Original feature route island |
| `/projects/:projectId/workloads/new` | `routes/workloads.new.tsx` | Original feature route island |
| `/projects/:projectId/workloads/logs` | `routes/workloads.logs.tsx` | Original feature route island |
| `/projects/:projectId/workloads/settings` | `routes/workloads.settings.tsx` | Original feature route island |
| `/projects/:projectId/workloads/:workloadKind/:workloadId` | `routes/workloads.$workloadId.tsx` | Original feature route island |
| `/projects/:projectId/:managedSection` | `routes/project.managed.$managedSection.tsx` | Original feature route island |
| `/_api/relations/:collection` | `routes/api.relations.$collection.tsx` | Project-scoped resource loader |
| `/*` | `routes/$.tsx` | Fuzor/service fallback |
