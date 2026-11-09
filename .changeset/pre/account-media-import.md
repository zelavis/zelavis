---
"zelavis": minor
---

Accounts and media can be imported from other systems: `POST /auth/accounts/import` (`client.auth.admin.importAccounts`, `zelavis auth import-accounts`) carries over profiles and PBKDF2-SHA256 passwords (Zelavis or Django format) and lists accounts whose hashes need a reset, and `POST storage/import` (`client.storage(projectId).import`, `zelavis storage import`) copies files from an S3-compatible bucket in resumable, checksummed pages.
