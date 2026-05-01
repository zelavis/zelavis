# Dashboard Asset Strategy

The `zelavis` package ships the dashboard as a built SPA artifact. The source
app lives in `@zelavis/ui`; `pnpm --filter zelavis build` builds that package
and generates an embedded dashboard asset module from `packages/ui/dist/client`.

## Current Runtime

The runtime serves embedded dashboard assets through the existing dashboard core service:

- `/zelavis` serves `_shell.html`
- `/zelavis/settings` and other dashboard routes serve the same shell
- `/zelavis/assets/*` serves fingerprinted assets with immutable caching
- public files such as `/zelavis/favicon.ico` are served with short caching

The shell is rewritten at runtime so the configured `rootPath` owns every
absolute dashboard link. A server mounted at `/admin` serves assets from
`/admin/assets/*` without rebuilding the UI.

## Adapter Direction

Keep the dashboard service contract stable and move asset loading behind a small
runtime boundary when non-Node adapters need it.

Recommended shape:

```ts
interface ZelavisDashboardAssetSource {
  list(): readonly ZelavisDashboardAsset[];
  read(path: string): Uint8Array | string | Promise<Uint8Array | string>;
}
```

The current direction is to keep dashboard serving fetch-native by default and
only step into Node-specific APIs for explicit Node-only helpers such as file-backed settings stores.
