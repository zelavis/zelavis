---
"zelavis": patch
---

Take the dependency backlog: TypeScript 7, ESLint 10, `@types/node` 26,
better-sqlite3 13, swiper 14, Changesets 3, and the GitHub Actions from v4 to
v7.

TypeScript 7 removed `baseUrl` and refuses non-relative `paths`, which four
example projects used to reach workspace sources. Their mappings are relative
now. It also stopped resolving ambient node types implicitly for those
projects, so each declares what it actually has: `types: ["node"]` where the
example uses node builtins, and `types: []` for the fetch-native example, which
depends on none and previously borrowed them by accident.

The `typeRoots` overrides are gone with it. They existed to work around pnpm's
non-hoisted layout, and each example now declares its own `@types/node`, so
default resolution finds it by walking up from the tsconfig.
