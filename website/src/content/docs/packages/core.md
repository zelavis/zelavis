---
title: "zelavis/platform"
---

`zelavis/platform` is the product-specific Platform control-plane service
identity bundled internally by `zelavis`. It gives the Platform runtime its
core service identity, mounts
Platform-owned runtime routes, and contributes the global Server navigation.

The service definition is intentionally small. Reusable service, endpoint, access,
Fabric, workload, and runtime-driver contracts remain in `zelavis/core`.
`zelavis/platform` assembles those primitives with Zelavis Platform authority;
it is not a separately published package or second framework.

## Boundary

- `zelavis/core` provides product-neutral engine contracts and utilities.
- `zelavis/platform` owns Zelavis Platform control-plane service metadata.
- `zelavis/marketplace` owns the global Marketplace contribution.
- `@zelavis/ui` owns the single dashboard application.
- `zelavis` composes those services into the long-running Platform OS.

Project runtimes do not mount `zelavis/platform`. They use `zelavis/core`
inside their own Project authority and are reached through the Platform
Gateway.

## Related docs

- [zelavis](./zelavis.md)
- [zelavis/core](./server.md)
- [Platform and App Services](../architecture/platform-app-services.md)
