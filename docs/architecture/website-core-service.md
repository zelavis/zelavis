# Website Core Service

The website core service is the current Zelavis bridge between the internal platform APIs and public website delivery.

## Current role

Today, the website core service does two things:

- exposes a versioned API for managing website pages
- serves public pages from `/` while keeping the dashboard namespace reserved

## Current mounted behavior

With the default runtime:

```txt
/zelavis
/zelavis/api/v1/website/pages
/
/*public-page-path
```

The dashboard stays under `/zelavis`, while public website pages can occupy `/` and other non-reserved paths.

## Why it is a core service

The website layer is now part of the default runtime because it affects how Zelavis owns routes at the root of an app:

- the dashboard and APIs need a protected namespace
- public pages need a safe place to live outside that namespace
- runtime settings such as page-builder availability depend on whether website support exists

## Current API surface

Current built-in routes include:

- `GET /zelavis/api/v1/website/pages`
- `POST /zelavis/api/v1/website/pages`

Current behavior includes:

- rejecting page paths reserved by the active Zelavis `rootPath`
- storing pages through the configured pages store
- rendering a simple public HTML response for matching pages

## Storage behavior

When the database core service is available, Zelavis can persist website pages through the built-in database-backed pages store.

That keeps website state aligned with the rest of the runtime instead of inventing a separate storage mechanism for early page-builder features.

## Boundaries

The website core service is still intentionally small.

Today it is not:

- a full CMS
- a theming system
- a template engine abstraction layer
- a general-purpose frontend framework

Its current job is to reserve the route model and provide a simple persisted page surface that the dashboard and future builder tooling can grow around.

## Related docs

- [Route Conventions](../reference/route-conventions.md)
- [Dashboard Settings](../reference/dashboard-settings.md)
- [zelavis package](../packages/zelavis.md)
