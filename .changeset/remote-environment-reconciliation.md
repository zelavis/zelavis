---
"zelavis": patch
---

Make remote environment persistence failure-safe and reconcile process state
after session reattachment. A session whose tenant projection cannot be written
is closed, a process whose projection cannot be written is terminated, and
providers may expose their attached processes so missing, stale, and orphaned
tenant process records are repaired on resume. Add idempotent, tenant-scoped
per-run usage records for provider token, context, cache, model, and billing-unit
reports.
