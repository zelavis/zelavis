---
"zelavis": patch
---

Describe every control-plane operation in the OpenAPI document.

Routes across runtime, platform, auth, fabric, database, workloads, the Project
and workload proxies, and the frontend front doors now declare an operation id,
a summary, tags, and their responses. A client generated from the document
names its methods after the operation rather than after a route id, and nothing
the Platform serves is left marked `x-zelavis-undocumented` — that marker now
belongs to installed services that ship a route without a `spec`.
