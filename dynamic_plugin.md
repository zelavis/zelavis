# Implementation review — 2026-09-15

The interrupted work contained a draft `createAPI` registry and route generator,
initial tests, a small documentation change, and related App recipe/loader cleanup.
It was uncommitted on `main`; the prior manifest-refactor branch had already merged
in PR #413. Continued on `codex/dynamic-plugin-api`.

Completed and corrected:

- Dynamic authoring APIs, namespace inference, public types and module augmentation.
- Conventional resource routes using existing SDK/HTTP/CLI operation discovery.
- Namespace ownership, loading-context isolation, atomic registration, duplicate
  route rejection, authoritative path IDs, and unambiguous JSON return values.
- Menu declarations use the same registry without importing the dashboard or
  generating menu HTTP routes. No dashboard rendering change is required.
- `@zelavis/ui` now reads all static identity and frontend metadata from its
  `package.json`, exports an explicit `register(options)` hook, creates its shell
  API with `zelavis.createAPI(..., { routes: false })`, and mounts runtime-only
  shell/dev behavior with `zelavis.frontend.configure(...)`.
- The official App, Auth, and Marketplace packages now register their menus and
  setup behavior through explicit SDK-backed `register()` hooks, including when
  Node returns a cached ESM module on a later independent load.
- App setup returns its backend services once; loader resolution preserves default
  setup functions, manifest metadata, and both SDK/exported authenticators.
- Regression tests and public documentation, including local versus remote calls.

Adjustments to the draft plan:

- A process-global registry for installed handlers would mix independent runtimes.
  Package authoring registries are isolated per loading context; installed calls use
  the existing endpoint-backed client and service lifecycle.
- Synchronous and asynchronous resource methods both generate routes, because an
  ordinary function may return a promise. Local helpers explicitly use `routes: false`.
- `get`/`read` use `/:id`; `list`/`find` use the collection path. Conflicting aliases
  are rejected. Explicit `operations.create` remains available for schemas and
  custom response codes, paths, and access requirements.

Validation:

- Root `pnpm run verify`: passed, including every workspace build and typecheck.
- Core suite: 1,099 passed, two environment-dependent skips, and one existing
  RocksDB TODO. UI: 67 passed. App: 8 passed. Auth: 3 passed. Marketplace: 3
  passed. Ecommerce and the remaining workspace package suites also passed.
- The Next.js scaffold type error was fixed by explicitly setting
  `NODE_ENV: "production"` in the child process environment; its regression test
  passes as part of the root verification.
- `pnpm docs:check` and `git diff --check`: passed.

The original proposal follows for reference.

---

# Implementation Plan: Dynamic Plugin APIs via `zelavis.createAPI()`

## Goal Description
Introduce an official `zelavis.createAPI()` function in the Zelavis SDK (`zelavis/sdk`). This allows service and plugin developers to dynamically register APIs under their plugin namespace (`zelavis.plugins.<namespace>.*`). Furthermore, functions registered through `createAPI()` will automatically expose corresponding HTTP Web API routes (when running in a plugin execution context), eliminating boilerplate route registration. Core `zelavis/sdk` will no longer hardcode `@zelavis/ui` menu methods directly; instead, menu registration will use the `createAPI()` mechanism, fulfilling the headless and modular service architecture.

---

## User Review Required

> [!IMPORTANT]
> **Dynamic Plugin Namespace (`zelavis.plugins`) vs. Static Autocomplete**:
> `zelavis.plugins` will be powered by a dynamic API registry (`Map<string, any>` / Proxy). Known official namespaces like `ui` will retain full TypeScript definitions, while third-party plugins will be accessible dynamically and can use TypeScript module augmentation (`declare module "zelavis/sdk"`) for typed autocomplete.

> [!NOTE]
> **Auto Web API Convention**:
> When a plugin registers an API object containing asynchronous methods (e.g. `zelavis.createAPI({ orders: { async list(query) {}, async create(body) {} } })`), `createAPI` inspects the object in the active plugin execution context and automatically mounts:
> - `GET /zelavis/api/v1/plugins/<namespace>/<resource>` (for `list`, `get`, `read`, `find`)
> - `POST /zelavis/api/v1/plugins/<namespace>/<resource>` (for `create`, `add`)
> - `PUT /zelavis/api/v1/plugins/<namespace>/<resource>/:id` (for `update`, `put`)
> - `DELETE /zelavis/api/v1/plugins/<namespace>/<resource>/:id` (for `delete`, `remove`)
> In-memory authoring APIs (like `ui.menus.create` that register sync wire contributions into `context.menus`) operate in-process without generating web routes.

---

## Proposed Changes

### Core SDK (`packages/zelavis/src/sdk/`)

#### [MODIFY] [packages/zelavis/src/sdk/fetch.ts](file:///Users/ivanjeremicx/Projects/zelavis/packages/zelavis/src/sdk/fetch.ts)
- Add `createAPI<T>(namespace: string, api: T): T` and `createAPI<T>(api: T): T` (inferring namespace from `activePluginContext`).
- Update `zelavis.plugins` to reference a dynamic plugin registry rather than hardcoding `{ ui: { menus: ... } }`.
- In `createAPI`:
  - Register the API tree under `zelavis.plugins[namespace]`.
  - If called within an active plugin context with executable handlers, automatically generate `ZelavisServerRoute` entries for standard REST methods (`list`, `create`, etc.) and append them to `context.routes`.
- Provide the baseline `ui.menus` registration using `createAPI("ui", { menus: { create(menu) { ... } } })` so runtime-neutral menu wire data continues to be collected into `context.menus` without hardcoded object literals in the SDK definition.

#### [MODIFY] [packages/zelavis/src/sdk/plugins.ts](file:///Users/ivanjeremicx/Projects/zelavis/packages/zelavis/src/sdk/plugins.ts)
- Integrate `createAPI` type definitions and auto-route mapping helpers.
- Export `ZelavisCreateApiFunction` and `PluginApiTree` types.

---

### UI Service Package (`packages/zelavis/services/zelavis-ui/`)

#### [MODIFY] [packages/zelavis/services/zelavis-ui/src/dashboard-service.ts](file:///Users/ivanjeremicx/Projects/zelavis/packages/zelavis/services/zelavis-ui/src/dashboard-service.ts)
- Ensure `@zelavis/ui` cleanly integrates with the dynamic `createAPI` registration system for dashboard-specific capabilities.

---

### Tests & Documentation

#### [NEW] [packages/zelavis/test/plugin-create-api.test.mjs](file:///Users/ivanjeremicx/Projects/zelavis/packages/zelavis/test/plugin-create-api.test.mjs)
- Test `zelavis.createAPI("myplugin", { hello() { return "world"; } })` and verify access at `zelavis.plugins.myplugin.hello()`.
- Test `zelavis.createAPI` inside a plugin execution context with inferred namespace.
- Test automated Web API route generation: verify that registering `{ items: { list(), create() } }` generates corresponding GET and POST server routes on the plugin.
- Verify `zelavis.plugins.ui.menus.create` works seamlessly through `createAPI`.

#### [MODIFY] [website/src/content/docs/guides/plugin-api.md](file:///Users/ivanjeremicx/Projects/zelavis/website/src/content/docs/guides/plugin-api.md)
- Document `zelavis.createAPI` with examples for exposing both in-process SDK APIs and automated Web APIs.

---

## Verification Plan

### Automated Tests
1. Run new test suite:
   ```bash
   node --test packages/zelavis/test/plugin-create-api.test.mjs
   ```
2. Run full test suite:
   ```bash
   pnpm --filter zelavis test
   ```
3. Test plugin loading and `@zelavis/app`:
   ```bash
   pnpm --filter @zelavis/app test
   ```

### Manual Verification
- Verify that calling `zelavis.createAPI` in an example plugin creates both the in-process JS method and the auto-generated HTTP route.
