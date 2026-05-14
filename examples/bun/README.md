This example embeds Zelavis inside a Bun server using Bun's native `Bun.serve()` and built-in SQLite driver.

## Getting Started

Make sure Bun is installed locally.

From the workspace root, run:

```bash
pnpm run build
pnpm run example:bun
```

Then open:

- http://localhost:3000/hello
- http://localhost:3000/zelavis
- http://localhost:3000/zelavis/api/v1/database/documents/collections

## Key Files

- `index.ts` starts a Bun server with `Bun.serve()` and configures `zelavisBun()`
- `zelavisBun()` provides the Bun SQLite driver and local file storage defaults
- data is stored in `.data/zelavis.sqlite`

## Why this exists

- Bun does not need a dedicated HTTP mount adapter because `Bun.serve()` is already fetch-native
- Bun does have a built-in SQLite driver through `bun:sqlite`
- This example proves the Bun-native server path and durable SQLite path together
