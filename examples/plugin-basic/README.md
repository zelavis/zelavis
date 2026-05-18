# Basic Uploadable Plugin Example

This example is a real Zelavis plugin that builds to an ESM module and a ZIP package you can upload through the dashboard Marketplace while the Node.js example is running.

It is intentionally small:

- one plugin root menu item: `Example Basic`
- one iframe-rendered dashboard page at `/zelavis/example-basic`
- one plugin-owned API route at `/zelavis/api/v1/example-basic/health`

## Build the plugin

From the workspace root:

```bash
pnpm --filter @zelavis/example-plugin-basic package
```

The package command prints the generated ZIP path:

```text
examples/plugin-basic/dist/example-basic.zip
```

## Upload it in the Node.js example

Start the Node.js example:

```bash
pnpm --filter @zelavis/example-nodejs dev
```

Open `http://localhost:3000/zelavis/marketplace`, then use **Upload plugin**:

- Plugin package: select `dist/example-basic.zip`

The upload registers the source first. In **Uploaded sources**, click **Install** to activate it.

After install:

- open `http://localhost:3000/zelavis/example-basic`
- open `http://localhost:3000/zelavis/api/v1/example-basic/health`

## What to upload

For Node.js local development, select `dist/example-basic.zip` in the browser file
picker. The Node adapter unpacks it into `.zelavis/plugins`, reads
`zelavis.plugin.json`, and imports the declared ESM entry from there.

You can still paste the absolute `dist/index.js` path into the ESM specifier
field when you want to test path-based local imports directly.

For production marketplace installs, the long-term contract is a package or URL
specifier resolved by the host adapter. Node can cache packages locally, while
serverless adapters should map installs to their own runtime activation boundary.
