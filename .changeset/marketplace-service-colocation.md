---
"zelavis": patch
"@zelavis/ui": patch
---

Move the marketplace service beside the pages it describes.

`zelavis/marketplace` now lives in `@zelavis/ui` with `routes/marketplace.tsx`
and `routes/project.marketplace.tsx`, exported from `@zelavis/ui/marketplace`,
following the pattern the dashboard service already uses. Its menu was
previously described in `src/platform` and copied into the dashboard's fallback
service list, so the two could drift.

The project-level Marketplace navigation entry is now a service contribution
rather than a literal in the dashboard's navigation builder — it was the one
Marketplace entry backed by no service at all.
