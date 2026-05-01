This example shows Zelavis mounted inside an existing Elysia app.

## What it demonstrates

- Elysia keeps owning the main app
- Zelavis is mounted through a native Elysia plugin instance
- the example stays close to the basic Bun-first Elysia style from the official docs
- dashboard links and API URLs stay stable at `/zelavis/*`

## Run

Make sure Bun is installed locally.

From the workspace root:

```bash
pnpm run example:elysia
```

Then open:

- `/hello`
- `/zelavis`
- `/zelavis/api/v1/dashboard/config`

## Key file

- `index.ts` resolves the Zelavis runtime, creates a minimal `new Elysia()` app, and mounts `elysiaAdapter(runtime)` with `app.use(...)`
