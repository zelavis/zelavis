---
"zelavis": minor
---

A divided Tenant is backed up whole: one file holding a backup per part (`zelavis.db-backup.divided.v1`), restored part by part into a Tenant divided the same way, with an `empty` restore checking every part before writing any. The backup routes, `client.projects.exportTenant|restoreTenant`, `zelavis projects export-tenant|restore-tenant` and the dashboard's Back up carry both formats.
