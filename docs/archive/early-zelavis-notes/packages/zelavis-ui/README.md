# @zelavis/ui

Zelavis UI package built with TanStack Start + Fumadocs. This is the **source** for the dashboard UI that gets bundled into Zelavis distros.

## Structure

- `/docs` - Main documentation (from `content/docs/`)
- `/zelavis` - Zelavis-specific documentation (from `content/zelavis/`)

## Development

```bash
bun run dev
```

Starts dev server on http://localhost:3000

## Building for Distros

This package builds to different targets for different Zelavis distros:

### Node Server (Default)
```bash
bun run build:node
```
Output: `.output/server/index.mjs` - Used by `zelavis-node`, `zelavis-bun`, `zelavis-deno`

### Cloudflare Pages
```bash
bun run build:cloudflare
```
Output: `.output/` - Used by `zelavis-cloudflare`

### Vercel
```bash
bun run build:vercel
```
Output: `.vercel/output/` - Used by `zelavis-vercel`

## Usage in Distros

Distros import the built output and combine it with the Zelavis JSON API:

```typescript
// Example: zelavis-node
import { handler as uiHandler } from '@zelavis/ui/server';
import { createZelavisHandler } from 'zelavis/server';

export function createNodeServer(db) {
  const apiHandler = createZelavisHandler(db);
  
  return async (req, res) => {
    if (req.url.startsWith('/api/json')) {
      return apiHandler(req);
    }
    return uiHandler(req); // Serves dashboard UI
  };
}
```
