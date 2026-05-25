# Zelavis documentation site

Public docs for Zelavis, built with [Astro Starlight](https://starlight.astro.build/).

## Content

Canonical documentation lives in `src/content/docs/`. Edit Markdown or MDX files there; Starlight exposes each file as a route from its path.

## Commands

From the repo root:

```bash
pnpm run website:dev
```

From this package:

```bash
pnpm dev
pnpm build
pnpm preview
```

## Deployment

The site builds as static Starlight output in `dist/`, suitable for Cloudflare Pages or any static host.
