---
title: "zelavis/marketplace"
---

`zelavis/marketplace` is the bundled Zelavis product service that contributes
the global Marketplace area at `/zelavis/marketplace`. It is an internal
service identity inside the unified package, not a separately published
package.

Keeping it separate from `zelavis/core` makes the boundary explicit: the
reusable server engine does not assume Zelavis product menus, marketplace
behavior, or dashboard ownership. The `zelavis` Platform chooses to
bundle this service alongside `zelavis/platform` and `@zelavis/ui`.

The global Marketplace is distinct from a Project-local marketplace. Global
entries cover Project recipes presented as apps and starters, plus templates
and server provider plugins;
Project-local entries install services and plugins into a selected Project.

## Related docs

- [zelavis](./zelavis.md)
- [zelavis/platform](./core.md)
- [Service Authoring](../guides/service-authoring.md)
