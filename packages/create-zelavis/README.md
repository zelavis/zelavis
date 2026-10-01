# create-zelavis

Creates a Zelavis Platform in a new folder.

```bash
npm create zelavis@latest my-platform
```

It writes `package.json`, `.gitignore`, `README.md` and a `.env` with a generated
one-time first-owner token, then installs `zelavis`. The dashboard and default
services ship inside the `zelavis` package; nothing else is installed beside it.

Options: `-y/--yes`, `--no-install`, `--no-git`, `--pm <npm|pnpm|yarn|bun>`.

The code is `src/index.ts` (what gets written) and `src/cli.ts` (the command). The
Zelavis release a new project gets is the one in this repository when the package
is built (`scripts/stamp-versions.mjs`), so publish this package with the Platform
release it should install. It runs no template fetched at run time.

See [Installation](https://zelavis.com/docs/getting-started/installation).
