---
title: "Server Control Plane"
---

The Server Control Plane is a native Platform subsystem of `zelavis`, not a
service and not a package. It gives the Platform runtime its privileged
control-plane routes — projects, domains, backups, logs, host operations,
settings, and the Assistant — under `/zelavis/api/v1/runtime/*`.

Native subsystems (the Server Control Plane, Identity, the Database engine, and
Fabric) are composed directly by `zelavis(...)` and mounted as **endpoint
groups**: an internal HTTP composition primitive that carries routes, an
access-checked handler context, and authenticators, but never a package
identity, menu, `kind`, or nested services. The runtime advertises what is
present through the `capabilities` document of `/runtime/config`; the `services`
list contains loadable packages only.

Reusable service, endpoint, access, Fabric, workload, and runtime-driver
contracts remain in `zelavis/core`. The control plane assembles those
primitives with Zelavis Platform authority; it is not a separately published
package or second framework.

## Boundary

- `zelavis/core` provides product-neutral engine contracts and utilities.
- The Server Control Plane owns Platform control-plane authority and routes.
- `@zelavis/marketplace` is a loadable package that owns the Marketplace.
- `@zelavis/ui` is the loadable `frontend` package that owns the single
  dashboard application, including the Server navigation.
- `zelavis` composes subsystems and packages into the long-running Platform OS.

Project runtimes do not mount the Server Control Plane. They use `zelavis/core`
inside their own Project authority and are reached through the Platform
Gateway.

## Related docs

- [zelavis](./zelavis.md)
- [zelavis/core](./server.md)
- [Platform OS and Project Recipes](../architecture/platform-project-recipes.md)
