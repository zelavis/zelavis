---
"@zelavis/ui": patch
---

Align Assistant UI Core with Assistant React, keep all Lexical packages on one
version, and remove a duplicate `isbot` dependency declaration so development
dependency optimization and dashboard typechecking succeed. Pre-optimize every
Base UI entrypoint used by the dashboard to prevent stale dependency hashes on
first load, and render an accessible hydration fallback while client modules
and root data are loading.
