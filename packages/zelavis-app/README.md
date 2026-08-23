# @zelavis/app

Official Zelavis App project service.

`@zelavis/app` is the first-party `kind: "app"` service that composes the
Zelavis-native project backend: database, auth, and workloads. Blueprints select
this service as the project application, and the project runtime mounts the
service inside the isolated project process rather than inside the Platform OS.

The package exports `zelavisAppService(...)` from `src/zelavis-app-service.ts`.
The published `zelavis` package also ships a built copy under
`packages/zelavis/services/zelavis-app` for local service-directory loading.
