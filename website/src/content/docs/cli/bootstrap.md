---
title: Bootstrap
---

`zelavis bootstrap` adds Zelavis endpoints to an existing framework app.

The command is interactive by default and asks for runtime adapter settings.
Use `--yes` with explicit flags for CI, templates, or agent-driven setup.

## React Router

React Router bootstrap targets React Router 7 Framework Mode apps:

```bash
pnpm dlx @zelavis/cli bootstrap react-router
```

Non-interactive example:

```bash
zelavis bootstrap react-router --adapter node --yes
```

Generated files:

```txt
app/lib/zelavis.server.ts
app/routes/zelavis.$.ts
```

If `app/routes.ts` exists, the CLI also tries to add:

```ts
route("zelavis/*", "routes/zelavis.$.ts")
```

The generated resource route forwards loaders and actions directly to
`zelavis.fetch(request)`. React Router already uses standard Web
`Request` and `Response` objects, so no framework wrapper is needed.

## Next.js App Router

App Router bootstrap creates a fetch-native route handler:

```bash
pnpm dlx @zelavis/cli bootstrap nextjs --router app
```

Non-interactive example:

```bash
zelavis bootstrap nextjs --router app --adapter node --yes
```

Generated files:

```txt
lib/zelavis.server.ts
app/zelavis/[[...path]]/route.ts
```

The route handler exports the common HTTP method handlers and forwards the
standard Web `Request` to Zelavis.

## Next.js Pages Router

Pages Router bootstrap creates an API route and keeps the public mount at
`/zelavis` through a Next.js rewrite:

```bash
pnpm dlx @zelavis/cli bootstrap nextjs --router pages
```

Non-interactive example:

```bash
zelavis bootstrap nextjs --router pages --adapter node --yes
```

Generated files:

```txt
lib/zelavis.ts
pages/api/zelavis/[[...path]].ts
next.config.ts
```

The API route uses `nextjsPagesRouterHandler(...)` from `zelavis/nextjs/pages`
because the Pages Router API shape is not fetch-native. The generated API route
disables the default body parser so Zelavis can read the request stream.

If a Next config already exists, the CLI does not rewrite it automatically unless
it can detect an existing Zelavis rewrite. Add this rewrite manually when the CLI
prints a warning:

```ts
{
  source: "/zelavis/:path*",
  destination: "/api/zelavis/:path*",
}
```

## Adapter Selection

The bootstrap command asks where the app will run because the generated
`zelavis` runtime module imports the selected environment adapter.

Supported adapters:

```txt
node
bun
```

React Router and Next.js bootstrap support the self-hosted runtime adapters
listed above.

## Options

```txt
zelavis bootstrap react-router [--adapter <adapter>] [--yes] [--cwd <path>]
zelavis bootstrap nextjs [--router app|pages] [--adapter <adapter>] [--yes] [--cwd <path>]
```

Options:

```txt
--adapter <adapter>   Select node or bun.
--router <router>     Select app or pages for Next.js.
--yes, -y             Use defaults and skip prompts.
--cwd <path>          Project directory. Defaults to the current directory.
--help, -h            Show help.
```

Defaults in non-interactive mode:

```txt
react-router       adapter: node
nextjs app         adapter: node
nextjs pages       adapter: node
```

## Idempotency

The CLI creates files only when they do not already exist. Existing runtime
modules and route files are skipped so local edits are not overwritten.

For route config files, the CLI performs small conservative edits. If it cannot
update a config safely, it prints the change to make manually.
