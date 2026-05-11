# Zelavis Docs

This folder is the framework-independent source of truth for public documentation.

## Principles

- Write docs in plain Markdown.
- Organize by durable product and package categories.
- Document current behavior first.
- Clearly distinguish implemented behavior from planned behavior.
- Keep this structure stable so a docs site can consume it later without forcing a rewrite.

## Sections

- [Getting Started](./getting-started/index.md)
- [Guides](./guides/index.md)
- [Packages](./packages/index.md)
- [Adapters](./adapters/index.md)
- [Architecture](./architecture/index.md)
- [Reference](./reference/index.md)
- [Versioning Strategy](./versioning.md)

## Version-ready structure

The docs are intentionally organized so future versioning can be added without changing the information architecture.

Current approach:

- `docs/` contains the current canonical documentation.
- Top-level folders represent stable sections, not framework-specific menus.
- File names should remain durable and descriptive.

Planned future path when multiple maintained doc versions are needed:

- `docs/current/...`
- `docs/v1/...`
- `docs/v2/...`

Until then, keep `docs/` as the single current source of truth.

## Start here

- [Installation](./getting-started/installation.md)
- [First Runtime](./getting-started/first-runtime.md)
- [Advanced Runtime Composition](./guides/advanced-runtime-composition.md)
- [Official Plugin Packages](./guides/official-plugin-packages.md)
- [Service and Plugin Authoring](./guides/service-and-plugin-authoring.md)
- [Dashboard Development](./guides/dashboard-development.md)
- [zelavis package](./packages/zelavis.md)
- [Node adapter](./adapters/node.md)
- [Environment Variables](./reference/environment-variables.md)
