---
"@zelavis/ecommerce": patch
---

Recognise the database instead of silently falling back to memory.

The plugin decided whether it had a database by duck-typing the value the setup
context hands it as `unknown`, requiring `forTenant`, `schemas` and
`capabilities`. `schemas` has since moved under `forTenant` and `capabilities`
was removed, so the guard answered "no" to every database it was given and the
plugin used in-memory repositories instead.

Nothing failed. Every write returned 201 on its way to being forgotten, no
collection was created, and a product written through one runtime was absent
from the next.

The guard now checks `forTenant` alone — the whole of what the plugin uses. A
host deliberately running without a database is still supported and still in
memory; a database that is present and unrecognised now stops the plugin from
starting, because storing a shop's customers and orders in memory it will lose
is worse than not starting.
