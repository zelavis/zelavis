---
title: Zelavis
---

The `Zelavis` class is the main entry point. It holds configuration, lazily initializes the runtime on the first request, and exposes the request-handling methods used by framework adapters.

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
| `adapter` | `ZelavisAdapter` | Platform adapter supplying runtime resources (storage, KV, execution context). See [Adapters](/adapters). |
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

Handles an incoming request and returns a standard `Response`. This is the method called by framework route handlers and edge runtimes that speak the fetch API.

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

Handles a plain (non-fetch-API) request object. Used by adapters that wrap non-standard request shapes before passing them to the runtime.

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
