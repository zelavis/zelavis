---
title: Cloudflare
---
The Cloudflare adapter contributes Cloudflare infrastructure to Zelavis while keeping core runtime code fetch-native.

```ts
import { Zelavis } from "zelavis";
import { cloudflareAdapter } from "zelavis/adapters/cloudflare";

export default {
  fetch(request: Request, env: Env) {
    const zelavis = new Zelavis({
      adapter: cloudflareAdapter({ env }),
    });

    return zelavis.fetch(request);
  },
};
```

## Runtime plugin activation

Cloudflare cannot mutate the already-running Worker in place. Runtime plugin installs need a host boundary such as Workers for Platforms dispatch namespaces or service bindings.

The adapter therefore accepts a plugin activation controller when the host has implemented that boundary. The first supported helper is `createCloudflareDispatchPluginActivation(...)`, which forwards activation requests to a Worker from a dispatch namespace:

```ts
import {
  cloudflareAdapter,
  createCloudflareDispatchPluginActivation,
} from "zelavis/adapters/cloudflare";

cloudflareAdapter({
  env,
  plugins: {
    activation: createCloudflareDispatchPluginActivation({
      dispatchNamespace: env.ZELAVIS_PLUGIN_DISPATCHER,
      workerName: (request) => `plugin-${request.pluginName}`,
      bindings: {
        ZELAVIS_ROOT_PATH: "/zelavis",
      },
    }),
  },
});
```

The plugin Worker should expose an activation endpoint such as `/__zelavis/plugin/activate`. It receives the plugin activation request as JSON and may return `{ "status": "active" }` or `{ "status": "pending", "message": "..." }`.

Without that controller, Marketplace can still update registry metadata, but the dashboard reports that runtime activation is not configured for the host.

## Related docs

- [Adapter Entry Points](./entry-points.md)
- [Cloudflare Plugin Workers](../architecture/cloudflare-plugin-workers.md)
- [Plugin and Service Model](../architecture/plugin-service-model.md)
