# Contributing to Zelavis

Thanks for contributing.

Zelavis is an early-stage backend platform built as a pnpm workspace of composable TypeScript packages. The project is still evolving quickly, so small, concrete, repo-aligned contributions are preferred over broad speculative refactors.

## Before you change code

Read these first:

- [README.md](README.md)
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [SECURITY.md](SECURITY.md)
- [AGENTS.md](AGENTS.md)
- [.github/copilot-instructions.md](.github/copilot-instructions.md)

Those files describe the current product direction, package boundaries, and repo-specific constraints.

## Current project focus

The main platform building blocks are:

- auth
- database
- shared server/runtime composition
- admin/dashboard UI

Today, the most important packages are:

- [packages/zelavis](packages/zelavis)
- [packages/server](packages/server)
- [packages/db](packages/db)
- [packages/auth](packages/auth)
- [packages/ui](packages/ui)

The ecommerce package is still useful, but it should be treated as an optional domain layer on top of the core platform.

## Core contribution principles

- Keep changes small and focused.
- Prefer explicit contracts over hidden magic.
- Keep core packages framework-agnostic unless they are explicitly adapters.
- Favor composition, plugins, and adapters over tight coupling.
- Avoid heavy dependencies unless clearly justified.
- Be clear about what exists today versus what is only planned.

## Repo layout

- `packages/*` contains core platform workspace packages.
- `plugins/*` contains official user-installable Zelavis plugins.
- `packages/*/adapters/*` contains framework or external runtime adapters.
- `packages/*/plugins/*` contains package-local capability/provider packages.
- `examples/*` contains runnable example workspace packages.
- `website/src/content/docs/` contains the public documentation source of truth.

## Local development

Install dependencies:

```bash
pnpm install
```

### Main dashboard development workflow

For end-to-end dashboard work, use:

```bash
pnpm run ui:dev
```

That starts:

- the Zelavis runtime, preferring `http://127.0.0.1:3000`
- the UI dev server, preferring `http://127.0.0.1:3001`

In this mode, requests to `/zelavis` are redirected to the live UI dev server.
If either preferred port is already in use, the script automatically selects the
next available local port.

### Other useful commands

```bash
pnpm build
pnpm test
pnpm typecheck
pnpm audit:security
pnpm ci:runtime
pnpm ci:ui
pnpm --filter ./packages/ui build
pnpm --filter ./packages/ui test
pnpm --filter zelavis test
```

## UI-specific notes

The UI package has extra rules:

- It uses TanStack Start, TanStack Router, shadcn/ui, and Tailwind CSS.
- Stay on the current Radix-based shadcn approach unless a migration is explicitly requested.
- `packages/ui/src/routeTree.gen.ts` is generated and should not be hand-edited.
- The sidebar uses a slide-based navigation model.
- The `Community` section belongs inside the first sidebar slide.

## Runtime-specific notes

- The main public runtime API is `zelavis()`.
- The default dashboard root path is `/zelavis`.
- The runtime supports dashboard dev-server mode through `coreServices.dashboard.devServerUrl` or `ZELAVIS_UI_DEV_SERVER`.

## Documentation expectations

When public behavior changes:

- update the relevant package README
- update the root README if the change affects project positioning or main workflows
- keep docs concrete and current
- avoid vague marketing language

## Tests and validation

Run the smallest useful validation for the area you changed.

The default CI baseline currently runs:

- `pnpm check`
- `pnpm --filter zelavis test`
- `pnpm ci:ui`
- `pnpm audit:security`

For lockfile or dependency changes, run the audit locally before opening a PR.

Dependabot, repository auto-merge, branch protection, issue forms, and GitHub
Discussions are already part of the repository workflow.

## Release workflow

Publishable packages use Changesets-based release management.

- create a release note: `pnpm changeset`
- prepare versions: `pnpm release:version`
- publish alpha builds: `pnpm release:publish:alpha`
- publish stable builds later: `pnpm release:publish:latest`

Examples:

- UI-only change: run UI build and tests
- runtime change: run Zelavis package tests
- cross-package change: run the relevant package tests plus any affected examples

If a test setup does not exist yet, keep the change easy to validate and document what was checked.

## Generated files and sensitive areas

Be careful with these:

- `packages/ui/src/routeTree.gen.ts` is generated
- `packages/*/dist/*` is build output
- `website/.astro/*` and `website/dist/*` are generated site output

## Pull request guidance

A good contribution usually includes:

- a focused problem statement
- the smallest coherent implementation
- updated docs if public behavior changed
- validation notes or test coverage

If you introduce a new abstraction, explain why the existing patterns were not enough.

## Architectural constraint: runtime neutrality

Zelavis core is intentionally built on JavaScript and standard Web APIs only.

Contributors should not:

- introduce Node-only assumptions into core
- couple core APIs to framework objects
- build core features around cloud/provider SDKs

Use adapter packages for host-specific behavior instead.
