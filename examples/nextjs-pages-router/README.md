This example embeds Zelavis inside a legacy Next.js Pages Router app.

## Getting Started

From the workspace root, run:

```bash
pnpm run build
pnpm run example:nextjs-pages-router
```

Then open [http://localhost:3000](http://localhost:3000) and try:

- `/zelavis`
- `/zelavis/settings`
- `/zelavis/api/v1/runtime/config`

## Key Files

- `pages/api/zelavis/[[...path]].ts` mounts Zelavis inside a Pages Router API route
- `next.config.ts` rewrites `/zelavis/*` requests into the internal API route
- `lib/zelavis.ts` creates and caches the shared runtime
- `pages/index.tsx` is the small landing page for this embedding demo

## Why this exists

- It proves Zelavis can still mount cleanly inside the old Pages Router model.
- It keeps the public URL at `/zelavis` even though the actual handler lives under `pages/api`.
- It complements the App Router example in [examples/nextjs](../nextjs).

## Notes

- The example API route disables the default Next.js API body parser so Zelavis can read the request stream directly.
- Requests are internally routed through `/api/zelavis/*`, then remapped back to `/zelavis/*` before hitting the Zelavis runtime.

For the fetch-native App Router variant, see [examples/nextjs](../nextjs).
