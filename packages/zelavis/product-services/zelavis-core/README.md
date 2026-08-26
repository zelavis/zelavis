# @zelavis/core

`@zelavis/core` is the Zelavis Platform control-plane service. It owns the
Platform runtime service identity and contributes the global Server dashboard
surface while using `@zelavis/server` for service, routing, access, and
workload-runtime primitives.

This package is product-specific. Reusable HTTP, service, Fabric, Agent, and
runtime-driver contracts belong in `@zelavis/server`.
