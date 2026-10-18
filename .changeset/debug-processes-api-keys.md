---
"zelavis": patch
"@zelavis/ui": patch
---

The terminal fills its window: it was fitted to nine columns because the island holding it was an inline element, which also made typed text hard to follow. API keys are now a section of Server → Access with presets (Debug read-only, Operator, Project client), one-time display, rotation and revocation. A new read-only diagnostic, `zelavis debug processes` (`client.debug.processes`, `GET /runtime/debug/processes`, permission `server.debug.read`), lists the Platform account's Zelavis processes with secrets removed and flags a command running more than once side by side.
