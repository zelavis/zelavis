# Maintainers

This file explains how Zelavis is maintained today and how contributors can
work with maintainers effectively.

## Current Maintainer

- `@ivanjeremic` — project owner and default reviewer across the repository

## Maintainer Responsibilities

Maintainers are responsible for:

- reviewing and merging pull requests
- triaging issues and discussions
- protecting API and architecture quality
- keeping release and security workflows healthy
- communicating breaking changes and roadmap direction clearly

## Ownership Areas

- `packages/zelavis/services/server` — service contracts, adapters, routing model
- `packages/db` — database core, storage contracts, adapters
- `packages/auth` — auth core, plugins, auth-facing server surfaces
- `packages/zelavis` — composed runtime, embedded dashboard delivery
- `packages/ui` — dashboard UX and frontend architecture
- `plugins/*` — official installable Zelavis plugins
- `.github/*` and release/config files — repo process, CI, dependency policy

## Triage Expectations

Issues should usually move through these stages:

1. `triage`
2. confirmed area and reproduction
3. `bug`, `enhancement`, `docs`, or another primary label
4. optional follow-up labels like `good first issue`, `help wanted`, or `breaking change`

Suggested baseline labels:

- `bug`
- `enhancement`
- `docs`
- `question`
- `triage`
- `good first issue`
- `help wanted`
- `blocked`
- `breaking change`
- `dependencies`
- `security`

## Merge Guidance

Before merging, maintainers should confirm:

- CI passed
- the scope matches the issue or PR description
- docs were updated when public behavior changed
- tests or validation notes are present for non-trivial changes
- breaking changes are called out clearly

## Release Guidance

Zelavis uses Changesets for publishable package changes.

Maintainers should ensure:

- release-impacting PRs include a changeset when needed
- alpha vs stable release intent is clear
- package readmes stay aligned with the shipped API

## Security

- Public security reports should be redirected to the private reporting path in `SECURITY.md`
- Dependency and CI changes should be reviewed carefully even when automated
- Dependabot auto-merge should stay limited to low-risk updates with passing checks
