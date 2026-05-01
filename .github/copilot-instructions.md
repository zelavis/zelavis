# Copilot Instructions for Zelavis

Zelavis is an early-stage backend platform built as a pnpm workspace of composable TypeScript packages.

## Product direction

- Think Firebase/Supabase-style foundation, but self-hostable and embeddable.
- Primary building blocks are auth, database, server/runtime composition, and admin UI.
- Optional domain packages such as ecommerce sit on top of the core platform.

## Primary packages

- `zelavis` is the high-level runtime package.
- `@zelavis/server` owns the shared service and route mounting contracts.
- `@zelavis/database` owns the database core.
- `@zelavis/auth` owns the auth core.
- `@zelavis/ui` owns the dashboard UI.

## Important repo conventions

- The main runtime function is `zelavis()`.
- Prefer small, focused edits.
- Avoid heavy dependencies unless clearly justified.
- Keep core packages framework-agnostic unless the package is explicitly an adapter.
- Favor service contracts, adapters, and plugins over hidden framework coupling.

## UI-specific guidance

- `packages/ui` uses TanStack Start, TanStack Router, shadcn/ui, and Tailwind CSS.
- Stay on the current Radix-based shadcn approach unless asked otherwise.
- `packages/ui/src/routeTree.gen.ts` is generated and should not be hand-edited.
- The sidebar uses a slide-based navigation model; each slide acts like its own sidebar panel.
- The "Community" section belongs inside the first slide.

## Dev workflow

- For dashboard end-to-end development, prefer `pnpm run ui:dev`.
- That starts the Zelavis runtime on port 3000 and the UI dev server on port 3001.
- In that mode, dashboard requests under `/zelavis` redirect to the live UI dev server.

## Documentation expectations

- Be concrete.
- Distinguish current functionality from planned functionality.
- Keep docs aligned with current package and runtime behavior.

## Runtime independence

Treat runtime neutrality as a hard architectural rule.

- Zelavis core may depend only on JavaScript/TypeScript and standard Web/ECMAScript APIs.
- Do not redesign core packages around Node.js, Bun, Deno, Cloudflare, Next.js, or any framework/provider runtime.
- Put runtime/framework-specific behavior only in `adapters/*` or adapter/plugin layers.
- If a proposal introduces runtime lock-in, reject it unless the user explicitly wants a runtime-specific adapter package.
