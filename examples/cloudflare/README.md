This example shows Zelavis running inside a Cloudflare Worker.

Cloudflare Workers are fetch-native: they receive a standard `Request` and return a standard `Response`, so no framework mounting adapter is needed. `zelavisCloudflare({ env })` is a platform adapter that contributes D1, KV, and R2 infrastructure.

## What it demonstrates

- Cloudflare Workers call `zelavis.fetch(request)` directly
- `zelavisCloudflare({ env })` infers the standard Cloudflare bindings for D1, KV, and R2
- the worker can still keep its own host routes like `/hello`
- Zelavis stays mounted at `/zelavis/*`
- the built-in dashboard works at the edge too

## Run

From the workspace root:

```bash
pnpm run example:cloudflare
```

Wrangler serves the worker locally at `http://localhost:8787` by default.
The example includes a local `ZELAVIS_DB` D1 binding in
`wrangler.jsonc`, so the dashboard should report the `cloudflare-d1`
driver during local development.

Then open:

- `/hello`
- `/zelavis`
- `/zelavis/api/v1/dashboard/config`

## Key file

- `src/index.ts` exports the standard Cloudflare module worker shape: `export default { async fetch(request, env, ctx) { ... } }`
- `src/index.ts` passes the whole worker `env` object into `zelavisCloudflare({ env })`, which handles Cloudflare binding discovery
- `wrangler.jsonc` defines the local D1 binding used by `wrangler dev`
