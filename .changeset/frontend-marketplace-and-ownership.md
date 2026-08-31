---
"zelavis": minor
---

Add the `frontends` marketplace category and Project ownership.

A frontend must carry the `frontends` category and depend on `zelavis` to be
listed in the marketplace. Listing is a promise that the frontend integrates —
that it can consume the menu and content APIs rather than only rendering — so it
is checked rather than assumed. A frontend that does neither is still
installable; it simply cannot be listed.

Projects can now own Projects. An owned Project is excluded from the Platform's
project list, is deleted with its owner through a durable cleanup participant
that runs before the owner's own runtime data, and its ownership survives a
restart. Reconciliation still sees owned Projects, because ownership is a
lifecycle boundary rather than a display rule.

This is the foundation for running a `server` frontend: it needs a process, a
data directory, a lifecycle, logs, and a routed target, which is what a Project
already is. Nested ownership is refused until placement grouping exists.
