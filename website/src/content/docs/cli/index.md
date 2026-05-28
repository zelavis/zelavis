---
title: CLI
---

`@zelavis/cli` provides command-line tools for bootstrapping, developing, and
operating Zelavis apps.

Use the CLI through a package runner when you do not want to install it globally:

```bash
pnpm dlx @zelavis/cli --help
npx @zelavis/cli --help
bunx @zelavis/cli --help
```

The package exposes a `zelavis` binary, so installed projects can also run:

```bash
zelavis --help
```

## Commands

- [Bootstrap](./bootstrap.md) - create framework-specific Zelavis endpoints for existing apps.
