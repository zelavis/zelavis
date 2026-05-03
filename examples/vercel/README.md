This example shows a minimal Vercel-style Next.js App Router setup using `vercelPlatform()`.

## What it demonstrates

- Zelavis mounted under `/zelavis`
- `vercelPlatform()` providing file storage through Vercel Blob
- the new storage core service exposed at `/zelavis/api/v1/storage/files/*`

## Key files

- `lib/zelavis.ts` creates `new Zelavis({ platform: vercelPlatform(...) })`
- `app/zelavis/[[...path]]/route.ts` forwards all mounted requests into Zelavis

## Notes

- This example expects Vercel Blob credentials in the environment when you actually run uploads.
- It is intentionally small and focuses on the platform wiring, not on a full product UI.
