This example shows a minimal Vercel-style Next.js App Router setup using `vercelPlatform()`.

## What it demonstrates

- Zelavis mounted under `/zelavis`
- `vercelPlatform()` providing file storage through Vercel Blob
- the new storage core service exposed at `/zelavis/api/v1/storage/files/*`

## Key files

- `lib/zelavis.ts` creates `new Zelavis({ platform: vercelPlatform(...) })`
- `app/zelavis/[[...path]]/route.ts` forwards all mounted requests into Zelavis

## Notes

- Vercel is the platform in this example. Next.js App Router is just the host framework shape we picked to demonstrate it.
- Vercel can also host static HTML or other server-backed setups. We used Next.js here because it is the most common Vercel deployment shape that still exercises the mounted runtime.
- This example does not need a Next.js adapter because App Router route handlers are already fetch-native: they receive a standard `Request` and return a standard `Response`, so `zelavis.fetch(request)` is already the cleanest integration path.
- The separate `nextjs-pages-router` adapter still exists for the older Pages Router shape, where Zelavis needs to adapt framework-specific request and response objects.
- This example expects Vercel Blob credentials in the environment when you actually run uploads.
- It is intentionally small and focuses on the platform wiring, not on a full product UI.
