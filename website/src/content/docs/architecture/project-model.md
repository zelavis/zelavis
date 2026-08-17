---
title: Project Model
---
Zelavis starts from Projects because the dashboard is meant to manage apps, websites, services, and hosting from one self-hosted control plane.

## Project scopes

A project is the operational unit shown in the dashboard. Different project types can expose different navigation:

- **Zelavis-native projects** use Zelavis backend primitives such as Auth, Database, Content, Media, Settings, and project plugins.
- **Managed app projects** represent software Zelavis hosts or manages, such as WordPress, static sites, or generic apps. These projects should expose hosting-style controls instead of pretending they use Zelavis Auth or Database.

The default starter project currently lives at:

```txt
/zelavis/projects/default
```

## Global areas

Some dashboard surfaces are intentionally outside any project:

- `/zelavis` opens the Projects overview.
- `/zelavis/marketplace` is the global Marketplace for apps, starters, templates, and server provider plugins.
- Global management pages cover Domains, Resources, Server, and Security.
  Server-owned backing routes currently live under `/zelavis/server/*` for
  areas such as domains, backups, and logs.

The global Marketplace can install or create new projects from apps and starters. Project plugins only make sense inside a Zelavis-native project, so they belong under:

```txt
/zelavis/projects/:projectId/marketplace
```

## Native hosting first

Zelavis should be able to host websites itself from the local runtime. A user can run Zelavis on a VPS, dedicated server, container, local machine, or future Deno-compatible host and manage domains, pages, files, logs, and backups from the dashboard.

External deployment providers are optional plugin targets. They can add useful capabilities such as DNS, CDN, object storage, image storage, email, or external website deploys, but they are not the place where the Zelavis runtime itself is expected to run.

## Roadmap direction

The project model should leave room for:

- multiple projects per Zelavis installation
- project grouping
- Zelavis-native and managed app project types
- global domains, resources, security checks, server backups, and logs
- ready-to-install apps and starters
- first-party project workloads for functions, jobs, schedules, and webhooks
- future distributed and multi-master operation without baking in single-node assumptions

Current UI and runtime behavior should document what exists today while keeping those boundaries explicit.
