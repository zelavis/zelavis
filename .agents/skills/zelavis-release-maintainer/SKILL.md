---
name: zelavis-release-maintainer
description: Use when preparing or reviewing Zelavis releases, including Changesets, version bumps, publish flow, package README alignment, and release-risk validation across the workspace.
---

# Zelavis Release Maintainer

Use this skill for:

- Changesets work
- versioning and release preparation
- package publish flow
- release-impacting dependency or API changes

## Working rules

- Keep release changes separate from unrelated refactors when possible.
- Prefer explicit release notes over vague changelog language.
- Make sure package README usage still matches the shipped API.
- Call out breaking changes clearly and early.

## Release checklist

1. Confirm which packages are actually affected.
2. Add or review the relevant changeset.
3. Verify public API and docs still match.
4. When the distribution footprint changes, verify the staged
   `share/uninstall.sh` inventory, isolated destructive-path test, and public
   complete-uninstall documentation cover every newly owned host resource.
5. Run the release validation commands before publishing.
6. Keep alpha vs stable intent explicit.

## Useful commands

```bash
pnpm changeset
pnpm release:status
pnpm release:version
pnpm release:version:alpha
pnpm release:publish:alpha
pnpm release:publish:latest
pnpm release:check
```
