---
title: Node Enrollment
---
A machine becomes a Fabric Node by **enrolling**: it presents a single-use credential
and its own certificate, and receives the Platform's public trust keys. Enrolling is
the authority to receive Project workloads, so the credential is short-lived, bound to
one node id and consumed exactly once.

## What exists

The enrollment API, the node registry behind it, and dispatch to registered nodes.
A node that enrolls after startup is listed in Fabric's inventory and can be sent
Projects without a restart, as long as this installation has remote dispatch
configured (`projects.remoteDispatch`, which may have an empty `nodes` map). Without
it the Platform does not publish its trust keys and answers `409 nodes-disabled`,
so no credential is issued that no machine could use.

## What does not exist yet

A worker install mode, so a fresh machine cannot yet be enrolled by running the
installer: it needs the enrollment call and a hand-started Agent. Automatic
provisioning of cloud machines (which would put the credential in first-boot data)
is not shipped. Trust keys are delivered once, at enrollment; the Platform's signing
keys rotate before they expire, so a refresh path is needed and is not built. The
caller's address is not known to the route (a proxy may sit in front), so the
credential is not bound to a source address.

## How it works

1. An operator issues an enrollment for a node id. The Platform returns a 256-bit
   token **once** and stores only its hash, with the node id and an expiry
   (default 60 minutes, at most 24 hours).
2. The machine generates its own TLS key and certificate and calls enroll with the
   token, its certificate and its HTTPS origin. The token is consumed with a
   compare-and-set before the node is registered. The same certificate may finish an
   enrollment that crashed after consuming; any other certificate is refused.
3. The Platform pins the certificate as that node's Agent, answers with the node id,
   the Agent id (`agent-<node id>`) and its public trust keys, and Fabric reports
   the node `ready` only once the Agent answers a health probe as that node.

A refusal is one answer, `403 Enrollment refused.`, whatever the reason: wrong
token, unknown node, expired, replayed or already used. The reason is kept for audit
and never sent. A node configured by the operator always wins over a registered node
with the same id, and the local node id can never be taken over.

## Operating it

```txt
GET    /zelavis/api/v1/runtime/nodes                  nodes and pending enrollments (server.nodes.view)
POST   /zelavis/api/v1/runtime/nodes/enrollments      issue a single-use credential (server.nodes.enroll)
POST   /zelavis/api/v1/runtime/nodes/enroll           a machine joins; the token is the credential, no session
DELETE /zelavis/api/v1/runtime/nodes/:id              revoke a node (server.nodes.manage)
```

SDK: `client.nodes.list()`, `createEnrollment({ nodeId, ttlMinutes?, replace? })`,
`enroll({ nodeId, token, certPem, url })` and `remove(nodeId)`.

CLI: `zelavis nodes list`, `zelavis nodes enroll-token <node-id> [--ttl-minutes N] [--replace]`,
`zelavis nodes enroll <node-id> --enrollment-token T --cert-file F --agent-url URL [--trust-out FILE]`
and `zelavis nodes remove <node-id>`. `--token` is the API bearer token, as for every
command; the enrollment credential is `--enrollment-token`.

Issuing refuses with `409` if the node is already registered or has an unused,
unexpired enrollment (`replace` replaces an unused one). Removing refuses with `409
node-in-use` while any Project is placed on the node, and leaves a tombstone, so the
node id is not silently reused. Enrollment attempts are limited to 120 a minute across
the Platform, which bounds the work an anonymous caller can cause; the tokens are
unguessable, so the limit protects resources, not secrecy.

## Not a secret store

Listing never shows a token, its hash or a certificate; it shows the certificate's
SHA-256. The Platform's trust keys returned at enrollment are public keys.
