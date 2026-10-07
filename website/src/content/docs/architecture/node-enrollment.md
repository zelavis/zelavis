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

## Joining from a machine

`zelavis worker join` makes the machine you run it on a Node of an existing Platform.
It is host-local, so it has no HTTP route of its own; the enrollment it performs is
the route below. It:

1. generates the Agent's key and a self-signed certificate on the machine, with the
   addresses the Platform will dial it by (no `openssl` needed); the key never leaves;
2. **authenticates the Platform before sending anything**: over `https` only, with
   either ordinary verification (`--platform-ca-file` for a private CA, otherwise
   Node's public roots) or a pinned certificate (`--platform-fingerprint sha256:...`,
   for a self-signed Platform). A pin is checked on the connection before a single
   request byte is written, and nothing is followed on redirect;
3. enrolls with the token and certificate, and writes the Agent's configuration, then
   prints the one command that starts it.

```txt
zelavis worker join --platform-url https://panel.example.com --node-id worker-1 \
  --enrollment-token <token> --address 203.0.113.11 [--port 8443]
zelavis agent --data-dir <dir> --remote-project-config <dir>/worker/remote-project.json
```

Joining is retryable: the key and certificate are kept, so repeating the command after a
crash or a lost response enrolls the same certificate, which the Platform lets finish. A
machine joins one Platform as one node; joining elsewhere means removing its `worker`
directory on purpose. The Agent must be reachable from the Platform on its port.

A Platform that has no hostname yet answers on plain HTTP only, and `worker join`
refuses that: the credential and the trust keys would cross an unauthenticated link.
Give the Platform a hostname with HTTPS first, or pin its self-signed certificate.

### The enrollment listener

For a Platform reached by IP address, the Platform can serve a narrow HTTPS listener
(`adapters/_enrollment-listener.ts`) with its own self-signed certificate
(`adapters/_platform-tls.ts`; key kept at 0600 in the Platform data directory, renewed when it
stops covering the addresses or nears expiry). The listener forwards exactly one request to the
runtime, `POST` to the enrollment path; every other path is a 404 that never reaches the
runtime, bodies are capped at 64 KiB and connections at 64, so opening its port exposes no
dashboard, API or Project. The host publishes where it listens and the certificate fingerprint
(`GET /runtime/nodes/platform`, `client.nodes.platform()`, `zelavis nodes platform`; needs
`server.nodes.view`), which is what `worker join --platform-fingerprint` pins. Tested over real
TLS: enrolling with the right pin, a wrong pin sending nothing, only the enrollment path being
forwarded, and an oversized body refused.

Turn it on with `zelavis serve --enrollment-port 8444 [--enrollment-address <ip-or-host>]...`
(a port from 1024; addresses default to the machine's first routable IPv4 and `localhost`, and
become the certificate's names). The **persistent host** serves it, so it survives an engine
replacement and drains with the engine; it forwards only
`POST /zelavis/api/v1/runtime/nodes/enroll` to the engine and answers 404 to everything else
without admitting the request. The engine publishes the endpoint, and enabling it also turns
remote dispatch on, so enrolled nodes receive Projects. Open the port in the firewall yourself:
nothing here changes the host firewall. Tested through the real host and engine (a machine
joins by pinning the published fingerprint; the dashboard, bootstrap and every other path are
unreachable on that port).

## Installing the worker role

`install.sh --role worker` installs a worker: one dedicated account, one unit that runs the
Agent once the machine has joined, and the same installation receipt as a Platform, with `role: "worker"`,
which complete removal reads. See [Installation](../../getting-started/installation/).
`zelavis worker join`, run as that account, does the enrollment. Qualified in a disposable
Debian/systemd container: the real installer, accounts and units, a real enrollment into a
real Platform runtime with the node reported `ready`, an update that restarts the running
Agent, the refusals, and complete removal.

## What does not exist yet

A worker is **not updated from the dashboard**: updating means running the installer again
on it, and nothing checks that a worker and its Platform run compatible versions.
`zelavis doctor` inspects a worker too (receipt, release, account, data ownership, whether it has joined, the path and Agent units, and that the Agent port is listening); it cannot tell whether the Platform can reach that port through a firewall. A default Platform install is HTTP-only until a
hostname and certificate are configured, and a worker refuses plain HTTP, so it can join
only a Platform with HTTPS or one whose self-signed certificate it pins (the enrollment listener above provides that). Automatic
provisioning of cloud machines (which would put the credential in first-boot data) is not
shipped. Trust keys are delivered once, at enrollment; the Platform's signing keys rotate
before they expire, so a refresh path is needed and is not built. The caller's address is
not known to the route (a proxy may sit in front), so the credential is not bound to a
source address.

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

## Cloud capacity

A Platform can create the machines that join it. `/runtime/cloud` (SDK `client.cloud`, CLI
`zelavis cloud`) holds one provider connection and the machines requested through it:

```
GET    /zelavis/api/v1/runtime/cloud               the connection, without its token   (server.cloud.view)
POST   /zelavis/api/v1/runtime/cloud/connection    connect a provider with an API token (server.cloud.connect)
DELETE /zelavis/api/v1/runtime/cloud/connection    forget the token                     (server.cloud.connect)
GET    /zelavis/api/v1/runtime/cloud/nodes         machines this Platform created      (server.cloud.view)
POST   /zelavis/api/v1/runtime/cloud/nodes         create a machine that enrolls itself (server.cloud.manage)
DELETE /zelavis/api/v1/runtime/cloud/nodes/:id     delete such a machine                (server.cloud.manage)
```

The provider token can create and delete machines in its cloud project, so connecting
needs its own permission, and a dedicated cloud project is recommended. The token is proved
by use (it must be able to list) before it is kept, is sealed with a key derived from the
Platform master secret, and is never returned, logged or put in a machine's first-boot data.
Every use is audited with the acting principal, and an action that cannot be recorded does
not run. Disconnecting is refused while machines this Platform created still exist, because
releasing them needs the token. The provisioning engine is composed in by the host
(`cloudCapacity` option); an installation without one answers `503 cloud-unavailable`.
A requested machine is created with first-boot data that installs the worker role and joins
with a single-use token, and it is `ready` only after it has enrolled. This path is built
and tested against a fake cloud; it has not yet been run against a real one.
