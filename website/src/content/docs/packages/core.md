---
title: "@zelavis/core"
---

`@zelavis/core` is the product-specific Platform control-plane service bundled
by `zelavis`. It gives the Platform runtime its core service identity, mounts
Platform-owned runtime routes, and contributes the global Server navigation.

The package is intentionally small. Reusable service, endpoint, access,
Fabric, workload, and runtime-driver contracts remain in `@zelavis/server`.
`@zelavis/core` assembles those primitives with Zelavis Platform authority; it
does not turn the reusable server package into the product shell.

## Boundary

- `@zelavis/server` provides product-neutral engine contracts and utilities.
- `@zelavis/core` owns Zelavis Platform control-plane service metadata.
- `@zelavis/marketplace` owns the global Marketplace contribution.
- `@zelavis/ui` owns the single dashboard application.
- `zelavis` composes those services into the long-running Platform OS.

Project runtimes do not mount `@zelavis/core`. They use `@zelavis/server`
inside their own Project authority and are reached through the Platform
Gateway.

## Related docs

- [zelavis](./zelavis.md)
- [@zelavis/server](./server.md)
- [Platform and App Services](../architecture/platform-app-services.md)
