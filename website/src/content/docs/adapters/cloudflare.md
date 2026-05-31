---
title: Cloudflare
---
The Cloudflare adapter contributes Cloudflare infrastructure to Zelavis while keeping core runtime code fetch-native.

```ts
import { Zelavis } from "zelavis";
import { cloudflareAdapter } from "zelavis/adapters/cloudflare";

export default {
  fetch(request: Request, env: Env) {
    const zv = new Zelavis({
      adapter: cloudflareAdapter({ env }),
    });

    return zv.fetch(request);
  },
};
```

## Runtime service activation

Cloudflare cannot mutate the already-running Worker in place. Runtime service installs need a host boundary such as Workers for Platforms dispatch namespaces or service bindings.

The adapter therefore accepts a service activation controller when the host has implemented that boundary. The first supported helper is `createCloudflareDispatchServiceActivation(...)`, which forwards activation requests to a Worker from a dispatch namespace:

```ts
import {
  cloudflareAdapter,
  createCloudflareDispatchServiceActivation,
} from "zelavis/adapters/cloudflare";

cloudflareAdapter({
  env,
  services: {
    activation: createCloudflareDispatchServiceActivation({
      dispatchNamespace: env.ZELAVIS_SERVICE_DISPATCHER,
      workerName: (request) => `service-${request.serviceName}`,
      bindings: {
        ZELAVIS_ROOT_PATH: "/zelavis",
      },
    }),
  },
});
```

The service Worker should expose an activation endpoint such as `/__zelavis/service/activate`. It receives the service activation request as JSON and may return `{ "status": "active" }` or `{ "status": "pending", "message": "..." }`.

Without that controller, Marketplace can still update registry metadata, but the dashboard reports that runtime activation is not configured for the host.

## Related docs

- [Adapter Entry Points](./entry-points.md)
- [Cloudflare Service Workers](../architecture/cloudflare-service-workers.md)
- [Service Model](../architecture/service-service-model.md)
