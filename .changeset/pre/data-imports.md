---
"zelavis": minor
---

Collections can be filled from another system's CSV, NDJSON or JSON export: `imports.plan` (dry run with row-numbered problems and a checksum), `imports.run` (bounded, idempotent, resumable batches) and `imports.verify` (content and checksum comparison for cutover), through the SDK, `POST …/documents/:collection/imports/plan|run|verify` and `zelavis data import-plan|import-run|import-verify --file`.
