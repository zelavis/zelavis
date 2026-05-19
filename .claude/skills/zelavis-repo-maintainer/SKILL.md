---
name: zelavis-repo-maintainer
description: Use when maintaining the Zelavis repository itself, including GitHub workflows, Dependabot, community files, issue templates, labels, release hygiene, and contributor-facing repo process.
---

# Zelavis Repo Maintainer

Use this skill for changes in:

- `.github/*`
- root docs such as `README.md`, `CONTRIBUTING.md`, `SECURITY.md`
- release and dependency workflow files
- contributor and maintainer process

## Working rules

- Keep contributor-facing docs concrete and current.
- Prefer simple automation with clear ownership over clever repo machinery.
- Do not claim GitHub settings are enabled unless they were verified.
- Separate repo-policy changes from product code changes when possible.

## Repo checklist

1. Update docs and templates together so they do not drift.
2. Keep issue labels and templates aligned.
3. Document any manual GitHub UI steps that cannot be done from code or CLI.
4. Leave unrelated local-only folders and machine state alone.

## Validation

Use the relevant checks for repo-health changes:

```bash
git diff --check
pnpm audit:security
pnpm ci:runtime
pnpm ci:ui
```
