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

- it uses `zelavisNodeServer({ platform: zelavisNode() })` as a single unified adapter
- `zelavisNode()` provides the Node infrastructure defaults; `zelavisNodeServer()` owns the HTTP server mount
- it is the easiest local setup for trying the storage service and copying a Zelavis file reference into a database schema field

## File-reference workflow

Once the runtime is running:

1. upload a file from `/zelavis/storage`
2. copy the file reference JSON
3. use that reference in a database document schema field validated with `imageFileSchema(...)` or `fileSchema(...)`
