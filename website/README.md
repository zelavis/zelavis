# Zelavis Website

This workspace package is the starting point for the public Zelavis website hosted on Cloudflare Workers.

## Current scope

Today this is only a minimal Cloudflare Worker scaffold that:

- serves a simple landing page at `/`
- keeps room for future website and docs routes
- forwards `/zelavis/*` requests into the Zelavis runtime

## Run locally

From the workspace root:

```bash
pnpm run website:dev
```

## Typecheck

From the workspace root:

```bash
pnpm run website:typecheck
```
