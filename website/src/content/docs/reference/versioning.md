---
title: Docs Versioning Strategy
---
Zelavis docs should be version-ready from the start without carrying versioning overhead too early.

## Current rule

Use `website/src/content/docs/` as the canonical home for current documentation.

Do not create version folders yet unless multiple maintained documentation versions actually exist.

## What to optimize for now

- stable folder names
- one topic per file
- minimal framework assumptions
- clear separation between current behavior and future ideas
- public docs in the website content tree, private design notes in `pnotes/`

## When to introduce version folders

Add versioned docs only when at least one of these becomes true:

- a stable major release needs frozen docs
- breaking changes make old docs worth preserving
- multiple supported major versions exist at the same time

## Expected future structure

```text
/website/src/content/docs/current/getting-started/
/website/src/content/docs/current/guides/
/website/src/content/docs/current/packages/
/website/src/content/docs/current/adapters/
/website/src/content/docs/current/architecture/
/website/src/content/docs/current/reference/
/website/src/content/docs/v1/
/website/src/content/docs/v2/
```

## Stability rules

- Keep section names durable.
- Avoid version numbers in filenames for current docs.
- Prefer moving a whole docs tree into `current/` later rather than renaming pages now.
- Keep package READMEs focused on package-local quickstarts and scope.
- Keep cross-package concepts and public guides in the website docs content tree.
