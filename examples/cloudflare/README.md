This example shows Zelavis running inside a Cloudflare Worker.

Cloudflare Workers are fetch-native: they receive a standard `Request` and return a standard `Response`, so no framework mounting adapter is needed. `zelavisCloudflare({ env })` is a platform adapter that contributes D1, KV, and R2 infrastructure.

## What it demonstrates

- Cloudflare Workers call `zelavis.fetch(request)` directly
- `zelavisCloudflare({ env })` infers the standard Cloudflare bindings for D1, KV, and R2
- the worker can still keep its own host routes like `/hello`
- Zelavis stays mounted at `/zelavis/*`
- the built-in dashboard works at the edge too
- optional plugin activation through a Cloudflare dispatch namespace

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
- `src/index.ts` wires `createCloudflareDispatchPluginActivation(...)` when `env.ZELAVIS_PLUGIN_DISPATCHER` exists
- `src/plugin-worker.ts` shows the plugin Worker activation endpoint contract at `/__zelavis/plugin/activate`
- `wrangler.jsonc` defines the local D1 binding used by `wrangler dev`

## Plugin Worker activation shape

When a Cloudflare dispatch namespace is configured, Zelavis can send plugin registry changes to a plugin Worker:

```ts
createCloudflareDispatchPluginActivation({
  dispatchNamespace: env.ZELAVIS_PLUGIN_DISPATCHER,
  workerName: (request) => `plugin-${request.pluginName}`,
});
```

The plugin Worker receives a standard JSON `POST` request at `/__zelavis/plugin/activate`:

```json
{
  "pluginName": "search",
  "action": "install",
  "specifier": "https://example.com/search.mjs",
  "registry": []
}
```

It should return:

```json
{ "status": "active" }
```

or:

```json
{ "status": "pending", "message": "Deployment still propagating." }
```
