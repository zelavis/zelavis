This example shows the default Node-oriented Zelavis runtime.

## Getting started

From the workspace root, run:

```bash
pnpm --filter @zelavis/example-nodejs dev
```

Then open:

- `http://localhost:3000/zelavis`
- `http://localhost:3000/zelavis/projects/:projectId`
- `http://localhost:3000/zelavis/projects/:projectId/media`
- `http://localhost:3000/zelavis/projects/:projectId/storage`
- `http://localhost:3000/zelavis/server/domains`

## Why this example matters

- it uses `nodeAdapter()` from `zelavis/adapters/node` for the Node infrastructure (SQLite, file storage, Platform System Store)
- it uses `createNodeServer(zv)` from `zelavis/runtimes/node` to spin up a standalone HTTP server
- it is the easiest local setup for trying the storage service and copying a Zelavis file reference into a database schema field
- when started through `pnpm dev`, workspace state is stored in `packages/zelavis/.zelavis`; otherwise the adapter uses `.zelavis` relative to this example unless `ZELAVIS_DATA_DIR` is set

## File-reference workflow

Once the runtime is running:

1. upload a file from `/zelavis/projects/:projectId/storage`
2. copy the file reference JSON
3. use that reference in a database document schema field validated with `imageFileSchema(...)` or `fileSchema(...)`

## Test Service Uploads

Use `examples/plugin-basic` as a real upload fixture for the Marketplace flow:

```bash
pnpm --filter @zelavis/example-plugin-basic package
pnpm --filter @zelavis/example-nodejs dev
```

Open `http://localhost:3000/zelavis/projects/:projectId/marketplace`, select
`examples/plugin-basic/dist/example-basic.zip` in **Upload service**, then install
it from **Uploaded sources**.

The service module defines its own `name`, `version`, menu, pages, and services,
so the dashboard does not ask for a separate service name. The Node adapter
unpacks the ZIP into the active data directory's `services` folder, reads
`package.json`, and imports the ESM entry declared in its `exports`.

After install, the service dashboard page is available at `/zelavis/example-basic` and its API health route is available at `/zelavis/api/v1/example-basic/health`.
