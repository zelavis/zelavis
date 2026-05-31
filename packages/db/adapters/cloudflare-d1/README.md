# @zelavis/db-cloudflare-d1

`@zelavis/db-cloudflare-d1` provides a Cloudflare D1-backed driver for `@zelavis/db`.

```ts
import { createCloudflareD1DatabaseDriver } from "@zelavis/db-cloudflare-d1";
import { Zelavis } from "zelavis";

export default {
  async fetch(request, env, ctx) {
    const zv = new Zelavis({
      coreServices: {
        database: {
          driver: createCloudflareD1DatabaseDriver({
            database: env.ZELAVIS_DB,
          }),
        },
        website: true,
      },
    });

    return zv.fetch(request, {
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

This package is intended for Workers/D1 environments. For Node.js use `@zelavis/db-node-sqlite`.
