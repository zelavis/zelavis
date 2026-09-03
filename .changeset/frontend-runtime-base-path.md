---
"zelavis": minor
"@zelavis/ui": minor
---

Make a frontend installable at any mount, not only the one it was built for.

A static bundle bakes its client-side router base path into the page it serves,
so the Platform rewrote React Router's `basename` literal on the way out. That
worked only because the Platform knew which framework it was serving: a
frontend could be supplied by an installation, but never installed at a path of
someone's choosing, which is the one thing a frontend manifest could not
express.

A frontend now declares `frontend.basePathGlobal` in its manifest, and the
Platform defines that global on the served page with the mount path. Nothing in
core knows what reads it. `@zelavis/ui` declares it and ships a small script
that applies the value to its router before hydration, so one build serves from
`/`, `/zelavis`, or anywhere else. The `basename` rewrite is gone.

Fixes unquoted CSS references never being rewritten. Both rewriters anchored on
an opening quote, but CSS writes `url(/assets/font.woff2)` with none — so every
font and background image on a mounted installation pointed at the server root
and 404ed. Verified in a browser: the dashboard now renders at `/admin` with
fonts loading from `/admin/assets/`.

The injected value escapes `<` as well as JSON-encoding it. The HTML parser
ends a script element at the first `</script>` even inside a string literal, so
a mount containing one would otherwise close the element.
