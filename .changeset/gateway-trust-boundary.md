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
