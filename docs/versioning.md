# Docs Versioning Strategy

Zelavis docs should be version-ready from the start without carrying versioning overhead too early.

## Current rule

Use `docs/` as the canonical home for current documentation.

Do not create version folders yet unless multiple maintained documentation versions actually exist.

## What to optimize for now

- stable folder names
- one topic per file
- minimal framework assumptions
- clear separation between current behavior and future ideas
- public docs in `docs/`, private design notes in `pnotes/`

## When to introduce version folders

Add versioned docs only when at least one of these becomes true:

- a stable major release needs frozen docs
- breaking changes make old docs worth preserving
- multiple supported major versions exist at the same time

## Expected future structure

```text
/docs/current/getting-started/
/docs/current/guides/
/docs/current/packages/
/docs/current/integrations/
/docs/current/architecture/
/docs/current/reference/
/docs/v1/
/docs/v2/
```

## Stability rules

- Keep section names durable.
- Avoid version numbers in filenames for current docs.
- Prefer moving a whole docs tree into `current/` later rather than renaming pages now.
- Keep package READMEs focused on package-local quickstarts and scope.
- Keep cross-package concepts and public guides here under `docs/`.
