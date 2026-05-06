This example shows Zelavis running inside a Cloudflare Worker.

It does not need a dedicated Cloudflare adapter helper because Cloudflare Workers already use the standard Web `Request` → `Response` fetch handler model that Zelavis exposes directly.

## What it demonstrates

- Cloudflare Workers can call `runtime.fetch(request)` directly
- no framework adapter is needed for a fetch-native platform
- the worker can still keep its own host routes like `/hello`
- Zelavis stays mounted at `/zelavis/*`
- the built-in dashboard works at the edge too
- `cloudflarePlatform({ env })` infers the standard Cloudflare bindings for D1, KV, and R2

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
- `src/index.ts` passes the whole worker `env` object into `cloudflarePlatform({ env })`, so the platform preset owns Cloudflare binding discovery
- `wrangler.jsonc` defines the local D1 binding used by `wrangler dev`
