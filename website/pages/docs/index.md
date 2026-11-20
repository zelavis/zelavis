---
layout: docs
title: "Zelavis Docs"
description: "Public documentation for Zelavis, the App Platform."
navTitle: "Overview"
---

# Zelavis Docs

Public documentation for Zelavis, the App Platform: backend primitives, native website hosting, project management, server operations, and a runtime-neutral dashboard.

## Principles

- Organize by durable product and package categories.
- Document current behavior first.
- Clearly distinguish implemented behavior from planned behavior.
- Keep section structure stable so future doc versioning can be added without a rewrite.

## Sections

- [Getting Started](/getting-started/)
- [Guides](/guides/)
- [Packages](/packages/)
- [Adapters](/adapters/)
- [Architecture](/architecture/)
- [Reference](/reference/)
- [Versioning Strategy](/reference/versioning/)

## Version-ready structure

The docs are intentionally organized so future versioning can be added without changing the information architecture.

Current approach:

- `website/pages/` contains the current canonical documentation.
- Top-level folders represent stable sections, not framework-specific menus.
- File names should remain durable and descriptive.

Planned future path when multiple maintained doc versions are needed:

- versioned doc trees under the website project (for example `current/`, `v1/`, `v2/`)

Until then, keep `website/pages/` as the single current source of truth.

## Start here

- [Installation](/getting-started/installation/)
- [First Runtime](/getting-started/first-runtime/)
- [Project Model](/architecture/project-model/)
- [Advanced Runtime Composition](/guides/advanced-runtime-composition/)
- [Official Service Packages](/guides/official-service-packages/)
- [Service Authoring](/guides/service-authoring/)
- [Dashboard Development](/guides/dashboard-development/)
- [zelavis package](/packages/zelavis/)
- [@zelavis/ui](/packages/ui/)
- [zelavis/app](/packages/app/)
- [Node adapter](/adapters/node/)
- [Environment Variables](/reference/environment-variables/)
