---
"zelavis": minor
---

A static frontend can declare `frontend.assetBase` — the path its own asset
references were built against, such as `/assets/`. The Platform rewrites those
references to wherever the frontend is actually mounted, so one build serves
from `/zelavis`, from `/`, or from anywhere else without being rebuilt.

Only the declared base is rewritten, and only where it starts a quoted string.
Rewriting every absolute reference would also rewrite links to API routes,
which are not the bundle's to move, and matching anywhere in a file would
rewrite prose and sourcemap comments.

This is what a JSON manifest could not express before: serving one build from a
configurable mount required a render function, which is why the dashboard had
to be composed into the Platform rather than installed like any other frontend.
