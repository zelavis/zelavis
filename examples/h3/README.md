This example shows Zelavis mounted inside an existing h3 app.

## What it demonstrates

- h3 can keep owning the main app
- Zelavis can be mounted under `/zelavis` without changing its external `rootPath`
- h3 uses a dedicated thin adapter so unmatched requests still fall through to the host app
- dashboard links and API URLs stay stable at `/zelavis/*`

## Run

From the workspace root:

```bash
pnpm run example:h3
```

Then open:

- `/hello`
- `/zelavis`
- `/zelavis/api/v1/dashboard/config`

## Key file

- `index.ts` creates an `H3` app, constructs `new Zelavis({ adapter: h3Adapter(), platform: nodePlatform() })`, and mounts it with `app.use("/**", zelavis.adapter.h3Handler())`
