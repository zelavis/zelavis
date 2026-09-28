---
"zelavis": minor
---

Publish an OpenAPI document that describes the API this runtime actually
serves.

The spec re-resolved endpoints from the service list using a different prefix
than mounting used, and none of the service prefixes — so it published
`/api/auth/accounts` for an endpoint served at `/zelavis/api/v1/auth/accounts`.
Every path in it was wrong. It now reads the routes mounting produced, so the
document and the router cannot drift apart.

It also described only routes carrying a `spec` field. Nothing in the
Platform's own control plane carries one, so a fresh installation published
fourteen auth paths out of fifty-nine routes while looking complete. Every
mounted route is described now; ones nobody has annotated are marked
`x-zelavis-undocumented` and take their operation id from the route id, so a
reader can tell which endpoints exist but have no inputs and responses written
down yet.

The document now carries a `servers` entry naming the origin it was fetched
from, and the router's `*rest` wildcards are converted to OpenAPI `{rest}`
rather than being emitted as literal asterisks.

`runtime/openapi` is served alongside `runtime/openapi.json`. The extensionless
path is what a reader tries first, and answering it with a 404 read as though
the Platform published no spec at all.
