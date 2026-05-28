# @zelavis/cli

`@zelavis/cli` provides command-line tools for bootstrapping, developing, and
operating Zelavis apps.

Use it directly through a package runner:

```bash
pnpm dlx @zelavis/cli bootstrap react-router
```

The React Router bootstrap target supports React Router 7 Framework Mode apps.
It creates a catch-all Zelavis resource route and a small server-side Zelavis
runtime module for the selected deployment adapter.

Next.js bootstrap supports both App Router and Pages Router:

```bash
pnpm dlx @zelavis/cli bootstrap nextjs
pnpm dlx @zelavis/cli bootstrap nextjs --router pages --adapter node --yes
```

For non-interactive usage:

```bash
zelavis bootstrap react-router --adapter node --yes
```
