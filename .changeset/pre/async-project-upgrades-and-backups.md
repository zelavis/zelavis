---
"zelavis": patch
"@zelavis/ui": patch
---

Run Project engine and recipe upgrades asynchronously with live progress tracking (`POST /zelavis/api/v1/runtime/projects/:id/upgrade` with `async: true` returning `202 Accepted`, SDK `async` option, CLI `zelavis projects upgrade --async`, and dashboard polling), avoiding 30-second request timeouts on slow upgrades.

Automatically remove empty pre-upgrade backups after a committed data-layout migration, keep non-empty backups safely retained, and move pre-upgrade backup management from the Projects overview cards into **Project → Settings**.
