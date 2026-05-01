# @zelavis/database-cloudflare-d1

`@zelavis/database-cloudflare-d1` provides a Cloudflare D1-backed driver for `@zelavis/database`.

```ts
import { createCloudflareD1DatabaseDriver } from "@zelavis/database-cloudflare-d1";
import { zelavis } from "zelavis";

export default {
  async fetch(request, env, ctx) {
    const runtime = await zelavis({
      coreServices: {
        database: {
          driver: createCloudflareD1DatabaseDriver({
            database: env.ZELAVIS_DB,
          }),
        },
        website: true,
      },
    });

    return runtime.fetch(request, {
      platform: {
        cloudflare: {
          env,
          executionContext: ctx,
        },
      },
    });
  },
};
```

This package is intended for Workers/D1 environments. For Node.js use `@zelavis/database-node-sqlite`.
