---
"zelavis": patch
"@zelavis/marketplace": patch
---

Ship the published WordPress 7.1.3-alpha.2 recipe as the fresh-install default in the bundled allow-list. Refuse Platform releases whose shipped allow-list defaults differ from the qualified official service versions; publish changed services and refresh the snapshot before building the Platform.

Settle cancelled Project reconciliation when a non-cancellable preparation fails during shutdown, including combined failure and interruption causes. This prevents an unhandled Promise rejection while keeping resource cleanup failures visible. Readiness still does not wait for the fleet.
