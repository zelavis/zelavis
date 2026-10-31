---
"zelavis": minor
---

Scheduled, encrypted, off-site backups: cron schedules (Effect `Cron`) that image the whole database, seal it with AES-256-GCM per part under a per-schedule key answered once as `recoveryKey`, and write it to an S3-compatible bucket or directory that passed the conditional-write probe, manifest last; retention, recorded runs, verification and restore through HTTP, the SDK, the CLI and the dashboard's Database → Images.
