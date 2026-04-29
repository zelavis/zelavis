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

Important: npm dist-tags and semver prerelease suffixes are different things.

- `changeset publish --tag alpha` publishes to the npm `alpha` dist-tag
- it does not automatically keep package versions on `-alpha.x`
- prerelease version numbers require Changesets prerelease mode

## One-time setup

1. Make sure you are logged in to npm.
2. Make sure you have publish rights for the `zelavis` package and the
   `@zelavis` scope.
3. Install workspace dependencies with `pnpm install`.

## Optional token-based publishing

Manual publishing remains supported.

If `NPM_TOKEN` is not set, the release scripts fall back to normal npm auth and
may prompt for browser or passkey confirmation during publish.

If `NPM_TOKEN` is set, the release scripts use it through a temporary npm config
so publishing can run non-interactively.

Example:

```bash
export NPM_TOKEN=your_publish_token
pnpm release:publish:alpha
```

This is useful for contributors who are authorized to publish and for future CI
or automated release flows, while still keeping manual terminal publishing
working unchanged.

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
pnpm changeset:add patch "Describe the user-facing change" zelavis @zelavis/server
pnpm release:version:alpha
pnpm release:publish:alpha
```

Suggested flow:

1. create one or more changesets
2. review the version bump and generated changelog changes
3. commit the generated version updates
4. publish with the `alpha` tag

`pnpm release:version:alpha` automatically enters Changesets prerelease mode for
the `alpha` tag if needed, then versions packages.

If you run plain `pnpm release:version` instead, Changesets treats the release
as a normal semver release and will drop `-alpha.x` suffixes.

You can still use the interactive `pnpm changeset` command, but `pnpm changeset:add`
avoids the terminal editor flow.

Usage:

```bash
pnpm changeset:add patch "Improve database route stability" zelavis @zelavis/server
pnpm changeset:add minor "Add new auth provider hooks" @zelavis/auth
pnpm changeset:add major "Rename the runtime config API" zelavis @zelavis/server
```

## Changelogs

Zelavis now uses Changesets changelog generation.

That means:

- each `.changeset/*.md` file is the source for the release note summary
- `pnpm release:version` updates package versions and package `CHANGELOG.md`
- only packages affected by the queued changesets get changelog entries

Write changesets as short user-facing release notes rather than internal commit
messages.

Good changeset summaries usually describe:

- what changed
- who the change affects
- whether anything is breaking or requires migration

## First stable release

When the public package surface feels ready for a non-prerelease release:

```bash
pnpm changeset
pnpm release:pre:exit
pnpm release:version
pnpm release:publish:latest
```

That publishes to the default `latest` dist-tag.

## Useful commands

```bash
pnpm release:check
pnpm release:status
pnpm changeset
pnpm changeset:add patch "Describe the user-facing change" <package...>
pnpm release:version:alpha
pnpm release:pre:exit
pnpm release:version
pnpm release:publish:alpha
pnpm release:publish:latest
```
