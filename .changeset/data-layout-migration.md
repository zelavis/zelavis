---
"zelavis": minor
---

A Project's data layout can change between releases, and the upgrade migrates it. Engine releases declare the data layout they write. A Platform update never moves a Project across a layout
change: a native App keeps its engine, and a managed app's bound App stays on the engine that wrote its data (also after a restart), and its Project reports `dataLayout` so its card offers
the upgrade even when its recipe is current. **Update recipe** then stops the Project, exports its database with the engine that wrote it, recreates collections, documents and schemas with the
current one, verifies them, and swaps them in with the original data kept as `data.format-<n>-<time>`; a failure puts the original back. The response carries a `dataMigration` report. Document
versions, change history and event positions restart, and idempotency receipts are dropped. The migration needs free space of about 3.5 times the data and fails, naming them, on record kinds it
cannot recreate yet.
