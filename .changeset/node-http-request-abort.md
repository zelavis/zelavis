---
"zelavis": patch
---

Fix Node HTTP requests carrying a body being cancelled mid-handler. The
per-request abort signal was driven from `IncomingMessage`'s `close` event,
which fires as soon as the request stream is drained — that is, the moment the
dispatcher parses the body — so every `POST`/`PUT`/`PATCH` handler awaiting
outbound work was aborted immediately. Most visibly, creating a table in a
Project failed with `Project "<id>" did not respond within 30000ms.` even though
the Project runtime answered normally. The signal now follows the response,
which closes only when the response finishes or the client really disconnects.

The Project Gateway also no longer reports a caller-side abort as a Project
timeout; it answers `499` with a distinct message instead.
