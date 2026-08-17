---
title: Mobile-Slot-Ready Dashboard
---
Zelavis dashboard features should be built once and composed differently across
desktop and mobile surfaces.

The desktop dashboard can show wide workspaces, adjacent panels, charts, forms,
and tables. The mobile browser or future Capacitor app should be able to place
the same feature pieces into slide-based navigation slots. That keeps mobile
from becoming a second dashboard implementation.

## Rule

Build feature behavior as reusable feature or panel components first. Routes
compose those components into the desktop content area. Mobile sidebar slides can
later mount the same components into named slots.

Below the dashboard desktop breakpoint (`lg`), the sidebar is the app shell.
The desktop content inset is hidden for phones and smaller tablets instead of
being squeezed beside the navigation. That keeps the mobile browser and future
Capacitor shell focused on slide navigation, with route panels mounted into
slots when a feature is ready.

Examples:

- a schema builder route can expose a field list, field editor, preview, and
  settings panel
- a domain route can expose overview, workflow, bindings, and provider boundary
  slots
- a security route can expose overview, checklist, and detail slots

## Slot Names

Use stable names for common slots:

- `overview` for route summary, status, and metrics
- `main` for the primary list, editor, or feature surface
- `create` for creation flows
- `edit` for editing flows
- `inspect` for read-only detail panels
- `settings` for configuration panels

Routes in `@zelavis/ui` can declare slot metadata through `handle.slots` and
wrap slot-ready content with `DashboardSlotLayout` and `DashboardSlot`.

## Data And Actions

Slot-ready components are presentation and interaction surfaces, not authority
layers.

Keep page-level data loading in React Router `clientLoader`s or resource routes.
If a slot can perform a platform action, the action should be backed by a
Zelavis server capability and endpoint so the dashboard, CLI, AI agents, scripts,
plugins, and external admin tools can perform the same operation.

## Why It Matters

This lets Zelavis keep one responsive product surface:

- desktop routes can remain rich and dense
- mobile browser and app shells can use slide-based navigation
- complex builders such as schemas, forms, content types, domains, and security
  checks can reuse the same panels
- future Capacitor shells can focus on app chrome instead of rebuilding the
  dashboard

The dashboard should be mobile-ready by construction, not rescued by a separate
mobile rewrite later.
