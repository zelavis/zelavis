---
"zelavis": patch
---

Every database operation now has a route, and a test that keeps it that way.

Five operations were reachable in process and nowhere else: `analyze`,
`locate`, `embed`, `withRelated` and `collectionExists`. They have routes now --
`POST /:collection/analyzer`, `/geometry` and `/embedding` to declare and
rewrite under an analyzer, a spatial index or an embedding; `POST
/:collection/related` to resolve what a page of documents references; and `GET
/collections/:collection/exists`.

The test is the point of this change. Wiring a capability is a separate step
from building one, nothing failed when it was skipped, and so it kept being
skipped -- three slices in a row shipped something the HTTP surface could not
reach, including an operation added to the runtime API one change earlier
without a route to call it.

Coverage is derived rather than listed. A hand-maintained map of operation to
route would rot in exactly the way the thing it is meant to catch rots, so the
test wraps the tenant API in a recorder, invokes every route the service mounts,
and asserts that every method a caller can reach in process was reached by one
of them. A capability added without a route now fails the build instead of
waiting to be noticed.
