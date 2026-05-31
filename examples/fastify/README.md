This example shows Zelavis mounted inside an existing Fastify app.

## What it demonstrates

- Fastify keeps owning the main app
- Zelavis is mounted through a native Fastify plugin shape
- unmatched requests still fall through to Fastify routes and not-found handling
- dashboard links and API URLs stay stable at `/zelavis/*`

## Run

From the workspace root:

```bash
pnpm run example:fastify
```

Then open:

- `/hello`
- `/zelavis`
- `/zelavis/api/v1/runtime/config`

## Key file

- `index.ts` creates a Fastify instance, constructs `new Zelavis({ adapter: nodeAdapter() })`, and registers `fastifyPlugin(zv)` (from `zelavis/fastify`) via `app.register(...)`
