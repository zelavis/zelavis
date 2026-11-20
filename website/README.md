# Zelavis Website & Documentation

Public website and documentation for Zelavis, built with [Fuzor](https://fuzor.dev/).

## Structure

- `pages/`: Static HTML and Markdown routes compiled into `dist/` (landing page, `/install/`, `/pricing/`, `/docs/`, and documentation pages).
- `layouts/`: Shared Fuzor HTML layouts (`marketing.html`, `docs.html`).
- `components/`: Reusable HTML-first Fuzor landing and UI components.
- `src/`: Styles, TypeScript client interactions, and structured marketing/navigation data.
- `public/`: Static assets (`favicon.svg`, `allowlist.json`, `brand/`). `install.sh` is synced from `../distribution/installers/install.sh` during dev and build.

## Local Fuzor Integration

When a local Fuzor checkout exists beside this repository (`../fuzor/packages/fuzor`), `scripts/fuzor-source.mjs` automatically rebuilds stale Fuzor sources and links `fuzor`, `vite`, `typescript`, and `shiki` against it. Otherwise (including CI), it uses the pinned `fuzor` from `node_modules`. Set `ZELAVIS_FUZOR=npm` to force the npm package locally.

## Commands

From the repo root:

```bash
pnpm run website:dev
pnpm run website:typecheck
```

From this package:

```bash
pnpm dev
pnpm build
pnpm preview
pnpm typecheck
```
