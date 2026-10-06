# Contributing to Zelavis

Zelavis is The App Platform. Start with [README.md](README.md) for the product
and [AGENTS.md](AGENTS.md) for canonical architecture and coding rules. These
apply whether you write code yourself or use an agent. Follow the
[Code of Conduct](CODE_OF_CONDUCT.md); report vulnerabilities through the private
path in [SECURITY.md](SECURITY.md).

## Get started

Use Git, Node.js 24 and the pnpm version pinned in the root
[package.json](package.json). From your clone:

```bash
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` starts the runtime and dashboard development servers, selecting free
ports if the preferred ones are busy. Use the URLs printed by the command.

Before working with Effect, fetch its matching source reference:

```bash
pnpm refs:sync
```

The reference checkout stays local in Git-ignored `repos/effect/`; it is optional
for ordinary installs, builds and CI. Sync derives the version from our manifests
and refuses to overwrite local changes. When upgrading Effect, include the
updated `scripts/reference-sources.json` in your PR. See the
[Effect guidance](.agents/references/effect-v4-guidance.md) for details.

For core-team members with GitHub Write access, `pnpm dev` also checks a shared
GitHub cleanup timestamp on startup and hourly; storage cleanup runs only when
seven days are due. It uses your own `gh` login and preserves security reports
and unknown items. GitHub errors never block development. See the
[maintenance guide](.agents/references/github-zero-spend.md#shared-cleanup-schedule-during-development)
for permissions, manual commands and `ZELAVIS_GITHUB_MAINTENANCE=0` to opt out.

## Find the right guidance

- [Core platform](.agents/skills/zelavis-core-platform/SKILL.md): unified `zelavis` package, runtime, Fabric and authority boundaries.
- [Dashboard](.agents/skills/zelavis-dashboard-ui/SKILL.md): `packages/zelavis/services/zelavis-ui`.
- [Repository maintenance](.agents/skills/zelavis-repo-maintainer/SKILL.md): CI, dependencies and contributor process.
- [GitHub zero-spend guide](.agents/references/github-zero-spend.md): billing controls, storage cleanup and local qualification.

These workflows and `AGENTS.md` own the detailed rules; this page is the starting
point. Reviewer ownership is recorded in [.github/CODEOWNERS](.github/CODEOWNERS).

## Validate your change

Run the checks relevant to your change and report the results. Common commands:

```bash
pnpm ci:runtime       # build, typecheck, tests and Effect checks
pnpm ci:ui:local      # dashboard smoke tests against a throwaway runtime
pnpm docs:check       # documentation checks
pnpm audit:security   # dependency audit
```

For the dashboard smoke tests, first install Chromium with
`pnpm --filter @zelavis/ui exec playwright install chromium`.
Run the audit for dependency or lockfile changes. Keep architecture details and
public documentation aligned with any changed behavior.

## Open a pull request

Use the [PR template](.github/pull_request_template.md). Explain the problem,
resulting behavior and relevant validation; call out breaking changes and
migration steps. Keep the scope focused, and discuss substantial API or
architecture changes in an issue before implementation. Never commit credentials,
local runtime data or generated build output.

## Release workflow

Publishable package changes use Changesets. Add a changeset when needed with
`pnpm changeset`. Maintainers should follow the
[release-maintainer workflow](.agents/skills/zelavis-release-maintainer/SKILL.md)
for validation, versioning and npm publishing.

Coding follows [the TigerStyle adaptation](.agents/references/tigerstyle-typescript.md)
for TypeScript and Effect v4. `pnpm verify` includes the repo-rule checks; TigerStyle has no debt allowances, and passing static checks does not replace
behavioral tests. The separate legacy Effect migration baseline may only shrink.
