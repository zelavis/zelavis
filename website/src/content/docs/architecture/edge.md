---
title: Zelavis Edge
description: Proxy-neutral ingress, certificate references, and safe reverse-proxy switching.
---

Zelavis Edge is the Platform's public traffic control plane. “Edge” means the
ingress boundary where HTTP, HTTPS, TCP, or UDP traffic enters an installation;
it is not a serverless runtime.

Traefik is the first bundled adapter, not the source of truth. Domains, route
intent, certificate references, the desired adapter, the active adapter, and
cutover progress belong to the Platform and its System Store. Traefik, Caddy,
Nginx, or an external load balancer receives compiled output from that state.
Changing adapters must therefore never require recreating a Project or moving
its data.

## Safe adapter switching

An adapter cutover is a durable transaction:

1. Preflight the target's installed state, health, and required capabilities.
2. Stage certificate references without making them authoritative for traffic.
3. Stage proxy-specific routing generated from one immutable publication.
4. Probe the staged target.
5. Activate certificates, then routing.
6. Drain the previous adapter.
7. Commit the active adapter and publication revision.

Each adapter operation is idempotent for the switch identifier. A failed probe
or activation rolls back the target routing and staged certificate material;
the active policy is unchanged. Certificate bytes are not stored in the System
Store. A certificate distributor resolves opaque references and can distribute
the secret material to local or remote Agents.

The API, JavaScript client, and CLI expose the same operations:

```bash
zelavis edge status
zelavis edge plan traefik --publication platform-routes@42 --routes 1 --require http --require https
zelavis edge switch caddy --publication platform-routes@42 --routes 1 --require http --require https
```

The switch commands are usable only when the host has supplied an operational
Edge manager and adapter. Packaged Linux releases include and supervise the
pinned Traefik binary with an empty route directory. The remaining host adapter
must compile canonical route publications, stage certificate material through
signed Agent operations, perform live probes, and atomically activate or roll
back the generated directory before the installer can publish a hostname.

## First-run hostname

Owner bootstrap and public ingress are separate authority boundaries. The first
owner is claimed through the private listener. Only afterward may an
authenticated Edge operation offer a managed hostname, an externally managed
endpoint, or “configure later.” The browser and terminal wizards currently
perform the authenticated Edge readiness check and leave public routing
disabled when the host integration is incomplete.
