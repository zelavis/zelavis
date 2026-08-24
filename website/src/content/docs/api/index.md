---
title: Zelavis
---

The `Zelavis` class is the main entry point. It holds configuration, lazily
initializes the runtime on the first request, and exposes the Web-standard
request-handling methods used by long-running hosts.

Zelavis API routes are the stable transport surface for platform capabilities. The dashboard should call the same capability endpoints that CLI commands, AI agents, scripts, plugins, and external admin tools can call.

```ts
import { Zelavis } from 'zelavis';

export const zv = new Zelavis({ adapter });
```

## Constructor

```ts
new Zelavis(options?: ZelavisOptions)
```

### `ZelavisOptions`

| Option | Type | Description |
|---|---|---|
| `adapter` | `ZelavisAdapter` | Runtime adapter supplying host resources such as storage and KV. See [Adapters](/adapters). |
| `rootPath` | `string` | URL prefix where Zelavis is mounted. Defaults to `/zelavis`. |
| `api` | `ZelavisApiOptions` | Options for the internal API router. |
| `services` | `ZelavisServiceRegistryOptions` | Static service entries and registry store. |
| `onError` | `ZelavisServerErrorHandler` | Global error handler called on unhandled runtime errors. |

### `ZelavisApiOptions`

| Option | Type | Description |
|---|---|---|
| `prefix` | `string` | Path prefix for API routes under `rootPath`. |
| `version` | `string` | API version string included in route paths. |

## Methods

### `fetch`

```ts
zv.fetch(request: Request, context?: ZelavisServerExecutionContext): Promise<Response>
```

Handles an incoming request and returns a standard `Response`. This is the
portable method used by fetch-style self-hosted runtimes.

```ts
// React Router resource route
export async function loader({ request }: LoaderFunctionArgs) {
  return zv.fetch(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return zv.fetch(request);
}
```

### `dispatch`

```ts
zv.dispatch(request: Request, context?: ZelavisServerExecutionContext): Promise<ZelavisDispatchResult>
```

Lower-level alternative to `fetch`. Returns a structured result object instead of a `Response`, useful when you need to inspect the matched route or response metadata before sending.

### `plain`

```ts
zv.plain(request): Promise<ZelavisPlainResult>
```

Handles a plain request object for tests and object-in/object-out embedding.

### `runtime`

```ts
zv.runtime(): Promise<ZelavisServerRuntime>
```

Returns the initialized server runtime. The runtime is created lazily on the first call and cached for subsequent requests. Calling this manually is rarely needed — `fetch` and `dispatch` call it internally.

## `platform`

```ts
zv.platform: ZelavisPlatformContext
```

Read-only accessor for the resolved platform context, available after the first call to `runtime()`. Contains the resources and metadata provided by the adapter.
