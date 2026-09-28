---
"zelavis": minor
---

Add the Frontend contract.

A package declares `"zelavis": { "kind": "frontend", "frontend": { ... } }` with
a `runtime` of `static` or `server`. The runtime is declared, never inferred: a
`start` script says nothing about whether a process should be spawned, and
guessing would make that decision depend on a heuristic.

Static frontends reuse the existing service `app` definition, including its SPA
and MPA modes, rather than growing a parallel file server, and they load without
a JavaScript entry because they are files rather than code. Bundle paths are
validated to stay inside the package.

Server frontends validate but do not install yet: they need a supervised process
and a routed target through the Project runtime, so they are refused with a
message that explains why rather than installing something that serves nothing.
Their start command is argv rather than a shell string, so a manifest cannot
smuggle shell metacharacters into process spawning.

Malformed frontends are refused at manifest validation, so a mistake surfaces at
install rather than as a broken site on first visit.
