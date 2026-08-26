# @zelavis/app

Official Zelavis App Project recipe and runtime stack.

`@zelavis/app` is the first-party `kind: "app"` service that composes the
Zelavis-native project backend: database, auth, and workloads. Project creation
selects this service as the application boilerplate, and the project runtime
mounts the service inside the isolated project process rather than inside the
Platform OS.

The package exports `zelavisAppService(...)` from `src/zelavis-app-service.ts`.
The `zelavis` package depends on and registers this package directly as an
official Project recipe. It is not copied into the Platform service directory.

Lower-level app modules are owned by this package:

```ts
import { createDatabase } from "@zelavis/app/db";
import { createAuth } from "@zelavis/app/auth";
import { workloadsService } from "@zelavis/app/workloads";
import { zelavisServer } from "@zelavis/server";
```

Zelavis Apps use the same product-neutral `@zelavis/server` engine as the
Platform, but with Project-scoped authority and resources. The Platform still
runs Projects out of process and reaches them through the Project Gateway; it
must not execute App services directly inside the Platform process.
