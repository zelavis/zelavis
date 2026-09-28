---
"zelavis": patch
"@zelavis/ui": patch
---

Restore a green typecheck on main.

Align every `lexical` and `@lexical/*` package on `^0.49.0`. `@lexical/link`
and `@lexical/rich-text` were left on `^0.46.0` by separate dependency bumps, so
`HeadingNode` and `QuoteNode` came from a different copy of the library than the
`ElementNode` they must be assignable to.

Export only the runtime-neutral backend contracts from the root entrypoint. The
concrete Native and Docker deployment backends import `node:` built-ins, and
re-exporting them from the root meant a fetch-native host could not typecheck
`zelavis` at all. They remain available through the `zelavis/backends` subpath,
which is where the Node adapter already imports them from.
