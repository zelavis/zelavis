---
"zelavis": major
---

`@zelavis/cli` is now `zelavis/cli`. The command layer moves into the Platform
package as its own build target, keeping the same `zelavis` binary and the same
separation between parsing commands and composing a runtime — as modules rather
than as published packages.

A CLI is not swappable the way a frontend is: nobody installs a different one.
A separate package published an artifact with a single consumer and a version
that had to match this one exactly.

The binary now loads the dashboard when it is present and runs without it when
it is not. `@zelavis/ui` is an optional dependency, so an installation ships
with a dashboard and keeps working after removing it — the API unchanged, the
root path saying no frontend is installed.

**Breaking:** anything importing `@zelavis/cli` imports `zelavis/cli` instead.
