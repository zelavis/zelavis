# Zelavis Server and Fabric Code/Security Review

Reviewed: 2026-08-30

Status: code-review findings and implementation checklist; no production code was changed by this review.

## Scope and review rules

This review covers the server/runtime dispatcher, Node HTTP host, Project manager and Node child runtime, Project Gateway proxy, Fabric inventory/planner, System Store boundary, and local service package loading. It also checks nearby tests and architecture documentation where they affect the server/Fabric security model.

The review deliberately does **not** classify prepared architecture as obsolete merely because it is not operational yet. In particular, the following are intentional and should remain until their roadmap replacement is implemented:

- the persisted retired `@zelavis/app` lock repair;
- `local-platform` and placement generation `1` in the current single-node projection;
- `independentRuntimeVersion: false`, `secureIsolation: false`, and `runtimeOwnership: "platform-process"` on the local Node driver;
- Agent, provider, artifact, migration, replica, and Project Cell contracts whose limitations are recorded in `TODO.md`;
- planned Fabric feature flags and the direct child-process map used by the supported local/small-host mode.

## Executive summary

The most important problem is the current Project Gateway trust boundary. A caller with only `project.view` can proxy every HTTP verb, the child runtime converts four unsigned headers into a wildcard system principal, and the proxy forwards the caller's cookies and authorization header. The same proxy also uses URL-reference resolution for a user-controlled wildcard path. Together, these behaviors can produce privilege escalation, credential disclosure, response-cookie injection, and server-side requests outside the selected Project runtime.

The local Node child driver is honestly described as operational isolation rather than a security sandbox. That limitation is not itself a bug. However, inheriting the complete Platform environment gives the child unnecessary access to bootstrap tokens, provider credentials, and other Platform secrets even within that documented trust model.

The remaining priorities are strict scope matching, request/body/archive limits, safe async HTTP error handling, atomic Project lifecycle transitions, and bounded Fabric planning input. Several small dead-code removals are available now, while the 4,988-line `src/index.ts` should be split by capability to reduce review surface without creating new package boundaries.

## Priority overview

| Priority | Finding | Primary risk |
|---|---|---|
| Critical | Project Gateway grants wildcard child authority and forwards ambient credentials | Project-view privilege escalation and secret exposure |
| Critical | Proxy target is not constrained to the selected runtime origin | SSRF / confused-deputy requests |
| High | Scoped grants with a missing ID match every ID of that scope type | Cross-Project or cross-service authorization bypass |
| High | HTTP/parser/proxy/archive paths have no explicit size budgets | Memory, CPU, and event-loop denial of service |
| High | Child processes inherit the full Platform environment | Platform secret disclosure to Project code |
| High | Project creation and lifecycle transitions are not atomic or serialized | Duplicate provisioning, stale state, and deletion races |
| Medium | Node HTTP async errors can escape without a response | Hung requests or unhandled rejection/process failure |
| Medium | Remote/data/file service sources and ZIP extraction need an explicit trust policy | Supply-chain execution and decompression abuse |
| Medium | Fabric status and placement projections overstate readiness | Incorrect control-plane inventory and future routing hazards |
| Medium | Error responses expose internal exception messages | Filesystem, topology, and implementation-detail disclosure |
| Low | Confirm filesystem permissions and close ownership for local SQLite stores | Local-user data exposure and resource leakage |

## Detailed findings and TODOs

### 1. Critical: preserve the caller's authority across the Project Gateway

Evidence:

- `src/index.ts:3938-3946` mounts GET, POST, PUT, PATCH, and DELETE proxy routes with only `project.view`.
- `src/adapters/_node-project-runner.ts:56-87` accepts four ordinary request headers and creates a `system` principal with global `permissions: ["*"]`.
- `src/index.ts:4004-4019` copies the inbound header set and then adds those unsigned authority headers.
- `src/index.ts:4030-4036` forwards child response headers, including `set-cookie`, to the Platform origin.

Impact:

- A principal allowed to view a Project can reach mutation/admin routes in the child as a wildcard system principal.
- Direct loopback callers can forge the four headers and obtain the same wildcard principal; binding to `127.0.0.1` is not authentication.
- Platform cookies and bearer credentials are sent into the child because the request header set is copied. A Project service can read or log them.
- A Project response can attempt to set or overwrite cookies for the Platform origin.

TODO:

- [ ] Replace the four-header trust check with an authenticated Gateway-to-Agent/runtime channel. For the local driver, use a per-runtime random secret or asymmetric signed principal envelope delivered out of band, with audience, Project ID, placement generation, expiry, and replay protection.
- [ ] Forward the actual Platform principal's allowed Project-scoped grants, not a wildcard principal. The child must enforce the route's own permission against that verified context.
- [ ] Make the outer proxy require only authenticated Project membership if downstream authorization is authoritative, or introduce separate read/invoke/admin Gateway capabilities. Do not use `project.view` as blanket mutation authority.
- [ ] Build outbound request headers from an allow-list. Strip `cookie`, `authorization`, proxy/hop-by-hop headers, and all client-supplied `x-zelavis-*` authority headers before adding the authenticated internal envelope.
- [ ] Define an explicit response-header policy. At minimum, block hop-by-hop headers and Project `set-cookie` from mutating Platform cookies; if Project cookies are needed, give them a namespaced path/name contract.
- [ ] Add tests with a principal that has only `project.view`: read succeeds, settings/account/database mutation fails, direct forged headers fail, Platform cookies never reach the child, and child cookies cannot replace the Platform session.

### 2. Critical: pin proxy requests to the selected runtime origin

Evidence:

- `src/index.ts:3999-4003` passes the decoded wildcard path to `new URL(path, runtimeUrl)`. A URL reference such as `https:/example.com/path` resolves to another origin rather than beneath the runtime base URL.
- `src/adapters/_node-project-runtime.ts:270-314` accepts the first JSON stdout event with `{ type: "ready", url: string }` without validating protocol, hostname, port, Project ID, or origin.

Impact:

The Platform becomes a confused-deputy HTTP client. In the current proxy this also combines with forwarded credentials. A compromised or faulty child can additionally advertise an arbitrary route target.

TODO:

- [ ] Construct the target by validating a relative path and mutating the pathname of an already validated runtime URL; reject scheme-like values, control characters, backslashes, encoded separators that change interpretation, and origin changes.
- [ ] After construction, assert `target.origin === runtimeOrigin` and that the final pathname remains under the intended proxy base.
- [ ] Validate Node-driver readiness through IPC or a dedicated inherited file descriptor instead of parsing ordinary stdout. At minimum require the expected Project ID, `http:`, `127.0.0.1`, an allowed ephemeral port, and no credentials/path/query/hash.
- [ ] Add regression tests for `https:/host`, encoded slash/backslash variants, malformed percent encoding, CR/LF, and a forged ready event.
- [ ] When the Agent boundary becomes operational, accept only Agent-reported healthy targets bound to the authoritative placement and generation.

### 3. High: make scope matching fail closed

Evidence:

- `src/core/runtime/request-dispatcher.ts:458-463` treats either an undefined required value **or an undefined granted value** as a match.
- The same `ZelavisAccessScope` type is used for route templates and concrete principal grants, so a stored grant can contain `{ type: "project" }` or `{ type: "service" }` without an ID.

Impact:

A Project-scoped grant with no `projectId` matches every Project route; the equivalent service grant matches every service. An unresolved route parameter can also weaken a requirement instead of failing closed.

TODO:

- [ ] Split route scope templates from resolved/concrete grant scopes at the type level. Principal Project grants must require `projectId`; service grants must require `serviceName`.
- [ ] Reject a required scope whose route parameter cannot be resolved.
- [ ] Match concrete IDs exactly. If an all-Projects grant is required, represent it as an explicit system/global permission rather than an omitted ID.
- [ ] Validate persisted account/session grants on read and write.
- [ ] Add negative tests for missing required ID, missing granted ID, wrong ID, wrong scope type, and malformed persisted grants.

### 4. High: add resource budgets before parsing or proxying

Evidence:

- `src/core/runtime/request-dispatcher.ts:319-346` fully buffers JSON, text, binary, URL-encoded, and multipart bodies with no configured limit.
- `src/index.ts:4020-4036` fully buffers proxy request and response bodies and has no downstream timeout or abort propagation.
- `src/adapters/_node-project-runtime.ts:270-323` keeps an unbounded partial stdout line; the log limit counts entries, not bytes.
- `src/adapters/_local-runtime.ts:150-164` inflates ZIP entries synchronously without compressed/decompressed size, ratio, entry-count, or total-size limits.
- `src/core/fabric/index.ts:615-696` validates number shapes but does not cap request count, replicas, string lengths, label count, or the total planning work.

Impact:

Large or intentionally pathological input can exhaust memory, block the event loop, or leave proxy connections waiting indefinitely. Fabric planning is permission-gated, but a compromised operator credential or accidental request should not be able to allocate an effectively unbounded array.

TODO:

- [ ] Add host-configurable global defaults and narrower per-route limits for bytes, multipart files/fields, JSON depth if a streaming parser is introduced, and response size where buffering remains necessary.
- [ ] Stream Gateway request/response bodies with backpressure. Propagate the inbound abort signal and add connect/header/overall downstream deadlines.
- [ ] Cap child stdout/stderr bytes per line and per Project, and record truncation explicitly.
- [ ] Reject ZIP64 until supported safely; validate central/local-header bounds, CRC, duplicate normalized paths, entry count, per-entry output, total expanded bytes, and compression ratio. Move large decompression off the event loop or use a streaming extractor.
- [ ] Cap Fabric requests, maximum replicas, allowed-node IDs, labels, and identifier lengths. Return `413` or a typed `400` before planning.
- [ ] Add boundary tests at limit-1, limit, and limit+1 plus compressed-bomb and long-log cases.

### 5. High: do not inherit Platform secrets into Project children

Evidence:

- `src/adapters/_node-project-runtime.ts:256-265` spreads all of `process.env` into every Project process.
- The driver correctly advertises `secureIsolation: false`; that prepared limitation should remain honest, but it does not require handing every child the control plane's environment.

Impact:

Project code can read bootstrap tokens, provider credentials, signing keys, database URLs, observability tokens, and unrelated service secrets present in the Platform environment.

TODO:

- [ ] Replace environment inheritance with a minimal allow-list (`PATH`, required runtime variables, locale/timezone where needed) plus explicitly scoped Project secrets.
- [ ] Remove one-time bootstrap material from the parent environment after bootstrap initialization where operationally safe.
- [ ] Introduce a Project secret-delivery contract that is scoped, audited, and replaceable by the future Agent/OCI implementation.
- [ ] Add a child-runtime test that plants a fake Platform secret in the parent and proves it is absent in the Project.

### 6. High: serialize and compare-and-set Project lifecycle operations

Evidence:

- `src/project.ts:689-723` implements create as `read` followed by unconditional `set`, despite `ZelavisSystemStore.setIfAbsent` being available.
- `src/project.ts:746-815` performs start/stop/restart with unconditional writes and no per-Project operation lock or persisted compare-and-set transition.
- Stop does not call `assertProjectIsOperable`, so it can race the durable deletion flow.
- Only deletion is deduplicated in-memory (`src/project.ts:820-828`); this does not coordinate multiple Platform processes.
- Reconciliation intentionally swallows per-Project failures (`src/project.ts:841-847` and the following start catch) but does not surface durable retry/health information.

Impact:

Concurrent create requests can both provision the same ID. Concurrent start/stop/restart/delete calls can overwrite desired/runtime state, start a process during cleanup, or leave the System Store inconsistent with the actual child.

TODO:

- [ ] Claim creation with `setIfAbsent` and cleanly resume or delete failed provisioning through the durable lifecycle.
- [ ] Add a per-Project in-process command queue now, then use System Store CAS with an operation ID/generation so multiple Platform writers cannot commit stale transitions.
- [ ] Make stop reject or join deletion once a tombstone exists.
- [ ] Persist reconciliation failure/retry metadata and emit an operator-visible event without turning Platform readiness into a fleet-wide wait.
- [ ] Add concurrent create/start-stop/restart-delete tests with delayed drivers and two managers sharing one store.

### 7. Medium: catch errors at the native Node HTTP boundary

Evidence:

- `src/core/runtime/node-http.ts:9-20` uses an async `createServer` callback without a boundary `try/catch`.
- Dispatcher route-handler errors are normally converted, but malformed URL/path decoding, request conversion, lifecycle hooks, socket aborts, and response streaming errors can escape outside that path.

Impact:

The client may receive no response, and runtime behavior depends on Node's unhandled-rejection policy. This is a reliability issue and a potential low-cost denial-of-service primitive.

TODO:

- [ ] Wrap request conversion, runtime fetch, and response streaming in a top-level handler that sends a generic `400` or `500` if headers are not sent and destroys the socket safely otherwise.
- [ ] Attach request/response abort/error handling and pass an abort signal into the Web `Request`.
- [ ] Set and document explicit `headersTimeout`, `requestTimeout`, `keepAliveTimeout`, header count/size, and connection limits appropriate to direct and reverse-proxy deployment.
- [ ] Test malformed percent-encoded paths, aborted uploads, lifecycle hook failures, and response-stream failures without unhandled rejection.

### 8. Medium: make service-code trust policy explicit and bound ZIP installation

Evidence:

- `src/adapters/_local-runtime.ts:358-387` allows remote sources by default and separately accepts `data:`, `file:`, arbitrary local paths, and package specifiers.
- The remote detector accepts both HTTPS and plaintext HTTP.
- Downloaded code is content-hashed but not authenticated against an expected digest or signature before import.
- ZIP installation uses synchronous unbounded inflation and a timestamp-only temporary directory (`src/adapters/_local-runtime.ts:290-329`).

Context:

`system.services.manage` is intentionally a code-execution-level permission; installing a plugin necessarily runs trusted code. The issue is making that authority and source policy difficult to misuse, not pretending plugins are sandboxed.

TODO:

- [ ] Default remote loading off for production/local adapters; require an explicit policy per allowed scheme and source.
- [ ] Reject plaintext HTTP by default and support expected digest/signature verification before activation.
- [ ] Decide whether `data:` and arbitrary `file:`/path specifiers are development-only. Gate them explicitly rather than tying only HTTP(S) to `allowRemote`.
- [ ] Use a collision-resistant temporary directory and the archive limits from finding 4.
- [ ] Audit every grant of `system.services.manage` as equivalent to host-code execution.

### 9. Medium: correct Fabric readiness and placement projections

Evidence:

- `src/index.ts:3504-3515` maps every Project status except `failed`, `provisioning`, and `starting` to `active`; therefore `stopping` and `stopped` appear active.
- `src/core/fabric/index.ts:482-495` reports `ready` when nodes are `draining` unless a separate node is degraded/unavailable.
- `src/core/fabric/index.ts:305-315` makes fixed mode default `max` to `min`, so `{ mode: "fixed", replicas: 3 }` resolves to one replica unless `maxReplicas` is also supplied.
- `src/core/fabric/index.ts:563-566` lets the point inventory path bypass the Effect error wrapping used by snapshot/list inventory.

Impact:

The current proxy also checks runtime status, limiting immediate routing impact, but inventory is inaccurate and becomes dangerous when the Gateway relies more heavily on authoritative Fabric state. The fixed replica default is surprising and can silently under-provision.

TODO:

- [ ] Represent stopped Projects as no placement or add an explicit inactive state; map stopping to a non-active state.
- [ ] Treat a draining local node as degraded and decide whether any draining node degrades the fleet summary.
- [ ] In fixed mode, use `replicas` as the default maximum when `maxReplicas` is omitted, or reject ambiguous policy input.
- [ ] Route point lookups through the same typed inventory error boundary and validate returned placement identity/scope.
- [ ] Add status-matrix tests for every Project and Node state and a fixed-policy test without `maxReplicas`.

### 10. Medium: return generic server errors and log structured details

Evidence:

- `src/core/runtime/request-dispatcher.ts:161-166` returns an exception's message by default.
- `src/core/runtime/create-runtime.ts:129-149` repeats the same behavior after emitting the error lifecycle event.
- Several Platform route helpers also serialize raw error messages.

Impact:

Filesystem paths, module specifiers, SQL details, internal service names, and topology information can be disclosed to remote clients. Some validation/conflict messages are useful and should remain typed client errors; unknown exceptions should not be returned verbatim.

TODO:

- [ ] Introduce one error-to-response mapper for typed public errors and stable error codes.
- [ ] Return a generic message plus correlation ID for unknown `500` errors; send the full cause to structured logs/lifecycle telemetry.
- [ ] Remove the duplicate fallback mapping in dispatcher/runtime composition.
- [ ] Add tests proving validation errors remain useful and unexpected errors do not leak their message.

### 11. Low: verify local filesystem permissions and store ownership

Evidence:

- `src/adapters/_sqlite-system-store.ts:17-19` creates the parent and SQLite file with process defaults.
- Project directories and `project.json` are also created with process defaults.
- `ZelavisSystemStore` has no `close` method, so the local SQLite handle cannot be released through the common resource lifecycle.

Impact:

On a host with a permissive umask or shared service account/group, other local users may read Platform/Auth/Project state. Repeated embedded runtime construction can retain SQLite resources until process exit.

TODO:

- [ ] Create sensitive directories as `0700` and files as `0600`, verify existing paths are not symlinks, and document the dedicated-service-user expectation for packaged deployments.
- [ ] Add an optional/idempotent store close capability and register it with Platform shutdown without breaking embeddable/custom stores.
- [ ] Add permission tests on POSIX hosts and a repeated create/close test.

## Code-size and maintainability improvements

These changes can reduce code or review surface without deleting prepared contracts:

### Safe dead-code cleanup now

Running TypeScript with `--noUnusedLocals --noUnusedParameters` found 15 issues. Server-adjacent confirmed candidates include:

- [ ] Remove unused `createWebsitePageRouteId` in `src/index.ts:2236-2241`.
- [ ] Remove unused `assertNoReservedServiceRuntimeServiceNames` in `src/index.ts:4457-4471`; the active reserved-name enforcement is already passed through `activateServiceRegistry` and covered by a passing test.
- [ ] Remove unused outer `addServices` in `src/service.ts:515-517` (the per-entry validated `addEntryServices` is the active path and must remain).
- [ ] Remove unused imports, including `ZelavisProjectRecord` in `_node-project-runtime.ts` and `ZelavisServicePackageInstaller` in `adapters/node.ts`.
- [ ] Review the remaining compiler findings individually, then enable `noUnusedLocals` and `noUnusedParameters` in CI so dead helpers do not accumulate.

Do not mechanically remove every compiler finding without review: public generic parameters may exist for API typing even when the emitted implementation does not reference them.

### Split the root implementation without recreating packages

`src/index.ts` is 4,988 lines and currently mixes option parsing, persistence adapters, website rendering, service registry management, storage endpoints, auth/database/workload resolution, Fabric projection, Project Gateway, and the public `Zelavis` facade.

- [ ] Move implementation into focused internal modules such as `platform/runtime-management`, `platform/project-gateway`, `platform/settings`, `platform/website`, and `platform/storage`, keeping the existing public exports and the one `zelavis` package.
- [ ] Extract shared JSON/store parsing and typed error mapping instead of repeating route-local `try/catch` blocks.
- [ ] Replace the five generated proxy route objects with one internal proxy-route factory that centralizes method policy, header filtering, target validation, streaming, timeout, and response filtering.
- [ ] Keep `src/core` runtime-neutral and keep product routing/hosting logic under `src/platform`; this follows the existing architecture rather than creating a parallel composition system.

### Remove global mutable manifest resolver state

`nodeAdapter()` and `bunAdapter()` install a process-global service manifest resolver. This makes two embedded runtimes affect each other and complicates tests.

- [ ] Pass the host resolver through resolved adapter/platform options into each `loadService` call.
- [ ] Deprecate and later remove the process-global setter/getter after all internal callers are injected.
- [ ] Add a test with Node-like and custom runtimes in one process to prove resolver isolation.

### Simplify Fabric runtime ownership

`createFabricApi` creates an Effect `ManagedRuntime` but exposes no disposal path. Either make the Fabric service lifecycle own and dispose it, or use the already-pure snapshot operations directly until Fabric requires managed resources. Do not remove Effect v4 merely for line count; choose the smaller lifecycle-correct shape after measuring how the service will evolve.

## Tests/checks to add before remote exposure

- [ ] Project-view-only Gateway matrix across all proxied child routes.
- [ ] Signed internal authority envelope: tamper, wrong audience, wrong Project, stale generation, expiry, and replay.
- [ ] Proxy target corpus and origin-invariance property test.
- [ ] Credential/header/cookie non-forwarding test.
- [ ] Concrete scope fail-closed property tests.
- [ ] Request, multipart, proxy, child-log, ZIP, and Fabric planner resource-limit tests.
- [ ] Concurrent Project lifecycle tests against one and two managers.
- [ ] Malformed/aborted native HTTP request tests with an unhandled-rejection sentinel.
- [ ] Fabric Project/Node state truth table.
- [ ] POSIX permissions and idempotent close tests.

## Documentation drift to fix

`ARCHITECTURE.md` contains obsolete status text, even though the prepared architecture itself remains valid:

- `ARCHITECTURE.md:61` says artifact build, digest, signing, and storage are not implemented, while `TODO.md` records digesting, Ed25519 signing primitives, staged manifests, and local persistent ArtifactStore as done. It should retain only the real gaps: release-key signing, remote storage, and immutable Project installation.
- `ARCHITECTURE.md:71` and `:159-165` still describe demo access and inconsistent Project/Fabric endpoint permissions. The runtime now derives dashboard access from a real principal and route-audit tests cover the critical control routes. Update this section while retaining the genuine Gateway authority-transfer findings above.

## Suggested implementation order

1. Fix Gateway authority propagation, outbound/inbound header policy, and target-origin pinning together; treating them separately leaves exploitable combinations.
2. Make scope matching fail closed and add the authorization regression matrix.
3. Add request/proxy/archive/planner limits and native HTTP error/abort handling.
4. Remove Platform environment inheritance and harden local filesystem permissions.
5. Serialize Project lifecycle transitions with create claims and CAS generations.
6. Correct Fabric status projections and fixed replica defaults.
7. Tighten service-code source policy and archive verification.
8. Centralize error mapping, split `src/index.ts`, remove confirmed dead code, and enable unused-code checks.
9. Refresh `ARCHITECTURE.md` and update `TODO.md` only when each behavior becomes operational.

## Validation performed for this review

- `pnpm --filter zelavis test`: **262 passed, 0 failed**.
- `pnpm audit --prod --audit-level low`: **no known production dependency vulnerabilities reported** on 2026-08-30.
- `pnpm --filter zelavis exec tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`: intentionally failed with 15 unused-symbol findings, providing the cleanup candidates above.

Passing tests establish the current expected behavior; they do not negate the missing adversarial, concurrency, and resource-limit cases listed in this document.
