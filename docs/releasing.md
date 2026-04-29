# Releasing Zelavis packages

Zelavis should ship to npm as a pre-1.0 package set first.

## Current public package set

The initial publishable packages are:

- `zelavis`
- `@zelavis/server`
- `@zelavis/database`
- `@zelavis/database-node-sqlite`
- `@zelavis/database-bun-sqlite`
- `@zelavis/auth`
- `@zelavis/auth-email-password`
- `@zelavis/auth-username-password`

These packages are currently versioned as `0.1.0-alpha.1` and should be
published under the `alpha` dist-tag first.

They are also configured as a fixed version group, so Zelavis and the current
core first-party packages move together on the same version.

Only example workspace packages are excluded from the release workflow.

All packages under `packages/` are intended to remain open and publishable.

## Recommended versioning policy

- Start with `0.1.0-alpha.1`.
- Keep prereleases on the `alpha` dist-tag while public APIs and naming are
  still moving.
- Do not publish `latest` until the install path and core runtime APIs feel
  dependable.

## One-time setup

1. Make sure you are logged in to npm.
2. Make sure you have publish rights for the `zelavis` package and the
   `@zelavis` scope.
3. Install workspace dependencies with `pnpm install`.

## First alpha publish

The initial public versions are already set in package manifests.

Run:

```bash
pnpm release:publish:alpha
```

That will:

- run typecheck, test, and build validation
- publish every non-private, non-ignored package that has not been published at
  its current version yet
- use the npm `alpha` dist-tag

## Subsequent alpha releases

After making package changes:

```bash
pnpm changeset
pnpm release:version
pnpm release:publish:alpha
```

Suggested flow:

1. create one or more changesets
2. review the version bump changes
3. commit the generated version updates
4. publish with the `alpha` tag

## First stable release

When the public package surface feels ready for a non-prerelease release:

```bash
pnpm changeset
pnpm release:version
pnpm release:publish:latest
```

That publishes to the default `latest` dist-tag.

## Useful commands

```bash
pnpm release:check
pnpm release:status
pnpm changeset
pnpm release:version
pnpm release:publish:alpha
pnpm release:publish:latest
```
