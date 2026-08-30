---
"zelavis": patch
---

Harden the Project Gateway trust boundary.

Gateway proxy targets are pinned to the selected Project runtime origin. The
wildcard path was resolved with `new URL(reference, base)`, so a value such as
`https:/example.com/pwn` resolved to a different origin and the Platform issued
the request there. The path is now treated as opaque segments, with traversal,
control characters, and malformed encoding rejected.

Platform credentials are no longer relayed into Project runtimes. `cookie` and
`authorization` authenticate the caller to the Platform, and a Project runtime
is ordinary Project code rather than a trusted peer. Client-supplied
`x-zelavis-*` authority headers and hop-by-hop headers are stripped, and
`set-cookie` is dropped from proxied responses so a Project cannot overwrite the
Platform session cookie.

Proxy verbs are authorized separately: reads require `project.view`, mutations
require `project.runtime.manage`. `project.view` was previously blanket
mutation authority against the child runtime.

Scope matching fails closed. A stored grant that omitted its `projectId` or
`serviceName` matched every Project or service of that type, and an unresolved
route parameter weakened the requirement instead of denying it.

Project runtimes no longer derive authority from unsigned headers. Four
ordinary request headers produced a `permissions: ["*"]` system principal, and
the runtime listens on loopback, so any local process could assert them.
Authority is now a short-lived envelope signed with a per-runtime secret,
verified for audience, expiry, and single use, and carrying the caller's own
Project permissions rather than a wildcard.

Project children no longer inherit the Platform environment. Spawning with all
of `process.env` exposed the bootstrap token, provider credentials, signing
keys, and database URLs to Project code; only variables a Node process needs to
run are forwarded now.

Project lifecycle transitions are serialized. Creation used a read-then-write
existence check, so two concurrent creates could both provision the same
identifier; it now claims the identifier atomically with `setIfAbsent`. Start,
stop, restart, and delete run through a per-Project queue, so a stale write can
no longer land after a newer one — previously a concurrent stop could write a
Project record back after deletion had removed it. Stop also refuses a Project
that is already being deleted.

Resource budgets are explicit where input was previously unbounded. Request
bodies are read with a byte ceiling and refused with `413` — `Content-Length`
is checked first as a cheap rejection, but the stream is also measured so a
lying or absent header cannot bypass the budget. Gateway request and response
bodies are capped and the downstream request carries a timeout and the caller's
abort signal. Child stdout no longer retains an unbounded partial line, and an
over-long log message is truncated explicitly rather than retained whole.
Fabric placement planning caps batch size, replica counts, identifier lengths,
and constraint entries.

Error-to-response mapping is centralized. Runtime composition repeated a
parallel fallback that had already diverged, reporting an oversized body as
`500` from one path and `413` from the other.

The native Node HTTP host has an error boundary. Request conversion, runtime
dispatch, and response streaming could all throw outside the dispatcher's own
mapping, leaving the client with no response and the process with an unhandled
rejection. Failures now answer `400` or `500`, or destroy the socket when
headers are already sent, and the server declares explicit header, request,
keep-alive, and header-count budgets. Requests also carry an abort signal so
handlers can stop when the client goes away.

Local state files are owner-only. The System Store database and its WAL
sidecars are created `0600` inside a `0700` directory, and Project directories
and `project.json` follow the same rule, so a permissive umask or shared
service account no longer exposes Platform, Auth, and Project state to other
local users. `ZelavisSystemStore` gains an optional, idempotent `close()` that
Platform shutdown calls, so a repeatedly constructed embedded runtime no longer
retains database handles until process exit.

Fabric projections are accurate. Only a running Project maps to an `active`
placement — `stopping` and `stopped` Projects were reported as active, and any
future status would have been too, because the mapping defaulted to active
rather than using an allow-list. A draining node now degrades the fleet summary
instead of reporting `ready`. In fixed replica mode `replicas` is the default
ceiling, so `{ mode: "fixed", replicas: 3 }` no longer silently resolves to a
single replica when `maxReplicas` is omitted; an explicit `maxReplicas` still
caps it.

Service source policy is explicit and opt-in. Remote loading defaulted to on,
plaintext `http:` shared a flag with `https:`, and `data:` URLs and arbitrary
filesystem paths were not gated at all. Each scheme is now enabled separately
through `services.sources`, with everything off by default; code the Platform
itself installed into its managed service directory is exempt, since it arrived
through the permission-gated install path. Installing a service remains a
code-execution-level action — the goal is to make that authority hard to
misuse, not to imply plugins are sandboxed.

Service package extraction is bounded: entry count, per-entry expansion, total
expanded bytes, and compression ratio, with duplicate normalized paths and
ZIP64 archives rejected rather than misread. Extraction uses a
collision-resistant temporary directory instead of a timestamp.

Plugin manifest resolution is supplied per runtime instead of installed
process-globally, so two embedded runtimes in one process no longer affect each
other's service loading. The `setServiceManifestResolver` /
`getServiceManifestResolver` globals are removed.

Confirmed dead code is removed and `noUnusedLocals` is enabled so it cannot
accumulate again. `noUnusedParameters` stays off deliberately:
`ZelavisServerFetchHandler<TService>` carries a public generic that callers
supply even though the declaration body does not reference it.
