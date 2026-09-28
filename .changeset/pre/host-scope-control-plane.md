---
"zelavis": patch
---

Stop serving the Platform control plane on a Project's domain.

A hostname bound to a Project is that Project's, not the Platform's. Requests to
`/zelavis` on a verified bound domain now answer `404` instead of returning a
Platform login page on every customer domain. The control-plane API was already
authenticated there, so this closes an exposure rather than a breach.

Enforced ahead of dispatch: the dashboard route matches before the public
forwarder runs, and route `host` fields are an allow-list resolved at
composition time while bindings are added and verified while the Platform runs.
