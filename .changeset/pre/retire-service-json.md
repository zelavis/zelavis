---
"zelavis": patch
"@zelavis/ui": patch
---

Retire the `zelavis.service.json` sidecar. Services and plugins are configured
through the `package.json` `zelavis` namespace and standard ESM `exports`, the
same as any other npm package.

Uploaded service packages now read their entry from `package.json` `exports`
through the shared manifest validator. A package configured only by the retired
sidecar is refused rather than silently installed.
