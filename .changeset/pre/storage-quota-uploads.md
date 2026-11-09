---
"zelavis": minor
---

Project storage gains quotas (total and per-file bytes, enforced on every write, import and upload) and signed, single-use direct uploads: an HMAC-bound link a browser sends bytes to without credentials, staged with their SHA-256 until an authorized caller confirms them, with abandoned uploads cleaned up. Available through `storage/quota`, `storage/uploads*`, the Platform's public `runtime/projects/:id/uploads/:token`, the SDK storage client, `zelavis storage quota|set-quota|create-upload|upload|confirm-upload|cleanup-uploads`, and the dashboard's storage page.
