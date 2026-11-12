---
"zelavis": minor
---

Separate App schema and collection/index definition authority (`project.data.define` / `database.define`) from record writes. Delegate exact data grants through the Project Gateway so POST queries work for read-only clients. Add the bounded Tenant change feed to HTTP, SDK and CLI, and distinguish collection updates/deletion in domain events. Allocate bulk-write identifiers and idempotency receipts in the data transaction instead of committing each allocation separately.
