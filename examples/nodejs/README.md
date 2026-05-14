This example shows the default Node-oriented Zelavis runtime.

## Getting started

From the workspace root, run:

```bash
pnpm --filter @zelavis/example-nodejs dev
```

Then open:

- `http://localhost:3000/zelavis`
- `http://localhost:3000/zelavis/media`
- `http://localhost:3000/zelavis/storage`

## Why this example matters

- it uses `nodeAdapter()` from `zelavis/adapters/node` for the Node infrastructure (SQLite, file storage, dashboard settings)
- it uses `createNodeServer(zelavis)` from `zelavis/node` to spin up a standalone HTTP server
- it is the easiest local setup for trying the storage service and copying a Zelavis file reference into a database schema field

## File-reference workflow

Once the runtime is running:

1. upload a file from `/zelavis/storage`
2. copy the file reference JSON
3. use that reference in a database document schema field validated with `imageFileSchema(...)` or `fileSchema(...)`
