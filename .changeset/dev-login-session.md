---
"@zelavis/ui": patch
---

Fix login and first-owner bootstrap in the two-origin dev setup.

The runtime issues session cookies only to same-origin requests. Vite's
`changeOrigin` rewrites `Host` but forwards the browser's `Origin`, so a
dashboard on the dev server (e.g. `http://127.0.0.1:3001`) reached a runtime on
another origin (e.g. `http://127.0.0.1:3000`) and every `set-cookie` was
silently dropped. Login returned 200 and the dashboard stayed unauthenticated.
The dev proxy now forwards the runtime's own origin, which is what the browser
actually sees.

`returnTo` is now router-relative. It was built from the browser pathname,
which includes the router basename, and then resolved through `navigate()`,
which prepends the basename again — sending a mounted dashboard to
`/zelavis/zelavis/` after sign-in.
