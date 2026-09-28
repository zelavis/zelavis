---
"zelavis": minor
"@zelavis/ui": minor
---

`@zelavis/ui` is now `kind: "frontend"` rather than a plugin that happens to
serve HTML. Its manifest declares the frontend it is — a static frontend over
the `build/client` bundle the package already ships — so validating it against
the frontend contract passes rather than being a label.

It stays composed rather than loaded from that manifest, which is what lets it
supply an `app.shell`. The installation's root path is a runtime setting, so
the built SPA's absolute asset references are rewritten per request, and a JSON
manifest cannot express a render function.
