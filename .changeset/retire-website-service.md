---
"zelavis": major
"@zelavis/ui": minor
---

Retire the built-in website content model.

The website core service owned a fixed page shape and rendered it with a single
hardcoded HTML template. Services have long had a richer mechanism for serving a
frontend — `ZelavisServiceAppDefinition`, with bundles, SPA and MPA modes, a
shell, and a dev URL — so the page model was a weaker parallel path.

A Project that has not chosen a frontend now serves an explicit placeholder at
its public paths, answering `503` with `no-store` and `noindex` rather than a
`404`, so an unfinished Project reads as unfinished rather than broken. Control
plane and API paths keep their own `404`s.

Removes `renderWebsitePage`, the website page types, the database and file
storage page stores, and the `website/pages` endpoints. The `@zelavis/website`
service is replaced by `@zelavis/frontend`, and the dashboard's Website area
becomes Frontend.
