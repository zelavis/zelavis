---
"zelavis": patch
---

Two more read-only diagnostics behind `server.debug.read`: `zelavis debug updates` shows the last ten finished updates with the installer's output, which the updater now keeps so a failed update can still be read after the next attempt; `zelavis debug project <id>` gathers one Project's record, runtime log, related Platform log entries and processes in one answer.
