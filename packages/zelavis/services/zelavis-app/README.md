# @zelavis/app

Official Zelavis App project service and production boilerplate source.

`@zelavis/app` is the first-party `kind: "app"` service that composes the
Zelavis-native project backend: database, auth, and workloads. Project creation
selects this service as the application boilerplate, and the project runtime
mounts the service inside the isolated project process rather than inside the
Platform OS.

The package exports `zelavisAppService(...)` from `src/zelavis-app-service.ts`.
The published `zelavis` package also ships a built copy under
`packages/zelavis/services/zelavis-app` for service-directory loading and
project boilerplate material.

Lower-level app modules are owned by this package:

```ts
import { createDatabase } from "@zelavis/app/db";
import { createAuth } from "@zelavis/app/auth";
import { workloadsService } from "@zelavis/app/workloads";
```
