---
title: "@zelavis/marketplace"
---

`@zelavis/marketplace` is the bundled Zelavis product service that contributes
the global Marketplace area at `/zelavis/marketplace`.

Keeping it separate from `@zelavis/server` makes the boundary explicit: the
reusable server engine does not assume Zelavis product menus, marketplace
behavior, or dashboard ownership. The `zelavis` Platform package chooses to
bundle this service alongside `@zelavis/core` and `@zelavis/ui`.

The global Marketplace is distinct from a Project-local marketplace. Global
entries cover apps, starters, templates, and server provider plugins;
Project-local entries install services and plugins into a selected Project.

## Related docs

- [zelavis](./zelavis.md)
- [@zelavis/core](./core.md)
- [Service Authoring](../guides/service-authoring.md)
