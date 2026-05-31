---
"@zelavis/cli": patch
"zelavis": patch
---

Remove `coreServices` from the public `Zelavis` class options and keep built-in services managed by the runtime defaults.

Add `zelavis services` CLI commands for listing, registering, installing, and disabling runtime services through the official runtime API.

Update generated bootstrap examples to export the Zelavis runtime singleton directly when no per-request platform context is required.
