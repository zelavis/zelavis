# Contributing to Zelavis

Thanks for contributing.

Zelavis is an early-stage backend platform built as a pnpm workspace of composable TypeScript packages. The project is still evolving quickly, so small, concrete, repo-aligned contributions are preferred over broad speculative refactors.

## Before you change code

Read these first:

- [README.md](README.md)
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
- [packages/database](packages/database)
- [packages/auth](packages/auth)
- [packages/ui](packages/ui)

The ecommerce package is still useful, but it should be treated as an optional domain layer on top of the core platform.

## Core contribution principles

- Keep changes small and focused.
- Prefer explicit contracts over hidden magic.
- Keep core packages framework-agnostic unless they are explicitly adapters.
- Favor composition, plugins, and integrations over tight coupling.
- Avoid heavy dependencies unless clearly justified.
- Be clear about what exists today versus what is only planned.

## Repo layout

- `packages/*` contains workspace packages.
- `packages/*/integrations/*` contains framework or external runtime adapters.
- `packages/*/plugins/*` contains optional capability/provider packages.
- `examples/*` contains runnable examples.
- `docs/archive/*` is historical material and should not be treated as current source of truth unless explicitly revived.

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

- the Zelavis runtime on `http://127.0.0.1:3000`
- the UI dev server on `http://127.0.0.1:3001`

In this mode, requests to `/zelavis` are redirected to the live UI dev server.

### Other useful commands

```bash
pnpm build
pnpm test
pnpm typecheck
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

Examples:

- UI-only change: run UI build and tests
- runtime change: run Zelavis package tests
- cross-package change: run the relevant package tests plus any affected examples

If a test setup does not exist yet, keep the change easy to validate and document what was checked.

## Generated files and sensitive areas

Be careful with these:

- `packages/ui/src/routeTree.gen.ts` is generated
- `packages/*/dist/*` is build output
- `docs/archive/*` is historical

## Pull request guidance

A good contribution usually includes:

- a focused problem statement
- the smallest coherent implementation
- updated docs if public behavior changed
- validation notes or test coverage

If you introduce a new abstraction, explain why the existing patterns were not enough.
