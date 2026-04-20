# Dashboard Asset Strategy

The `zelavis` package ships the dashboard as a built SPA artifact. The source
app lives in `@zelavis/ui`; `pnpm --filter zelavis build` builds that package
and copies `packages/ui/dist/client` into `packages/zelavis/dist/dashboard`.

## Current Runtime

The Node-compatible runtime reads copied files from `dist/dashboard` and exposes
them through the existing dashboard core service:

- `/zelavis` serves `_shell.html`
- `/zelavis/settings` and other dashboard routes serve the same shell
- `/zelavis/assets/*` serves fingerprinted assets with immutable caching
- public files such as `/zelavis/favicon.ico` are served with short caching

The shell is rewritten at runtime so the configured `rootPath` owns every
absolute dashboard link. A server mounted at `/admin` serves assets from
`/admin/assets/*` without rebuilding the UI.

## Integration Direction

Keep the dashboard service contract stable and move asset loading behind a small
runtime boundary when non-Node integrations need it.

Recommended shape:

```ts
interface ZelavisDashboardAssetSource {
  list(): readonly ZelavisDashboardAsset[];
  read(path: string): Uint8Array | string | Promise<Uint8Array | string>;
}
```

Node can keep using filesystem assets. Cloudflare can use a generated manifest,
Workers Assets, or an integration-provided binding. Bun can use its native file
APIs. The dashboard service should not know which storage mechanism is active;
the runtime integration should provide the asset source.

This keeps `zelavisServer` ergonomic while leaving room for Cloudflare D1,
Turso, Bun, and other deployment targets.
