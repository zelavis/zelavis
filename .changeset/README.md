# Changesets

Use Changesets to manage version bumps for the publishable Zelavis packages.

Typical flow:

1. Run `pnpm changeset` after making a user-facing package change.
2. Commit the generated file under `.changeset/`.
3. Run `pnpm release:version` when preparing a release commit.
4. Publish with `pnpm release:publish:alpha` or `pnpm release:publish:latest`.

Ignored packages in `.changeset/config.json` stay private and are not part of
the npm release set.
