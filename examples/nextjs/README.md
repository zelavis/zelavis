This example embeds Zelavis inside a Next.js App Router project.

## Getting Started

From the workspace root, run:

```bash
pnpm run example:nextjs
```

Then open [http://localhost:3000](http://localhost:3000) and try:

- `/zelavis`
- `/zelavis/projects/:projectId`
- `/zelavis/projects/:projectId/settings`
- `/zelavis/api/v1/runtime/config`

## Key Files

- `app/zelavis/[[...path]]/route.ts` mounts Zelavis under `/zelavis`
- `lib/zelavis.ts` creates and caches the shared runtime
- `app/page.tsx` is the small landing page for this embedding demo

## Why this exists

- It proves Zelavis can run without a Node-specific adapter.
- It shows how App Router can host the dashboard directly.
- It is the first example of the new Web-first execution model.
