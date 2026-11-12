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
pinned Traefik binary. Default system installations publish an HTTP fallback
through the canonical route store and enable the proxy on ports 80 and 443.
`http://<server-ip>/zelavis/` works without a hostname; management listeners stay
on loopback unless explicitly exposed. Hostname-specific routes outrank this fallback. The remaining host adapter
must compile canonical route publications, stage certificate material through
signed Agent operations, perform live probes, and atomically activate or roll
back the generated directory before the installer can publish a hostname.

## Where Edge runs

Edge needs a host that can run signed Agent operations. On a packaged Linux
install it is active. In repository development (`pnpm dev`) there is no proxy at
all: the runtime serves the dashboard and API directly, and the Traefik adapter
is created only when the host has an Agent and host operations. Caddy exists today
only as a test fixture that proves the contract fits a second proxy. See
[Execution Backends and Traffic](./execution-backends.md) for why Traefik is the
default.

## First-run hostname

Owner bootstrap and public ingress are separate authority boundaries. The first
owner can be claimed through production HTTP ingress or the private management listener. Only afterward may an
authenticated Edge operation offer a managed hostname, an externally managed
endpoint, or “configure later.” The browser and terminal wizards currently
perform the authenticated Edge readiness check and leave hostname/TLS setup incomplete when the host integration is unavailable.
Choosing “configure later” leaves IP-based HTTP ingress active. HTTPS is not
established by the HTTP fallback.

## Connect a Project hostname

In the Platform dashboard, open the Project and choose **Domains → Add
domain**. A customer needs `project.view` and `project.domains.manage` scoped
to that Project. Server operators can inspect verified hostnames under
**Server → Domains**.

1. Enter an exact apex or subdomain, such as `example.com` or
   `app.example.com`, and select its TLS mode. Connect each hostname separately.
2. Point its A or AAAA record, or a subdomain CNAME, at the ingress address your
   server operator provides. Also create the TXT record shown in Domains,
   `_zelavis-challenge.<hostname>`, using the exact displayed value.
3. Choose **Verify DNS** after the TXT record propagates. The challenge expires
   after 24 hours. The complete TXT record name must fit DNS length limits.
   Generate a fresh challenge in Domains if it expires, and
   wait 30 seconds between TXT checks on the same domain.
4. Choose **Open site** once the domain is active. Retry activation from the
   same domain entry if ingress or certificate issuance is pending.
5. Choose **Remove domain** to withdraw the route. Project deletion also
   withdraws its domains. For externally terminated TLS, remove the external
   proxy's hostname mapping when disconnecting the domain.

DNS TXT proof grants ownership of that exact hostname. A pending challenge
occupies one of the Project's 20 domain slots. Edge claims the global hostname
after proof, including when ingress setup still needs attention. Existing
Platform and Project claims take precedence. A verified hostname stays
reserved while its published route is being withdrawn.

### TLS and ingress

- **External TLS** uses a certificate and reverse proxy configured by the
  operator. Configure `ZELAVIS_EXTERNAL_PROJECT_DOMAIN_TARGET` in the Platform
  service environment with its fixed loopback HTTP listener, for example
  `http://127.0.0.1:3000`. For an embedded Node Platform, use
  `nodeAdapter({ externalProjectDomainTarget: "http://127.0.0.1:3000" })`.
  Forward the hostname's traffic to that listener, preserve the original
  `Host`, and set `X-Forwarded-Proto: https` at the proxy. The Platform probes
  its local listener with the hostname and records that route in Edge inventory.
  The external proxy owns public reachability, certificate validity and renewal.
- **Zelavis-managed HTTPS** requires a working Edge adapter, public HTTP-01
  reachability and the certificate controller. After TXT proof, Zelavis checks
  DNS and the local HTTP ingress, orders or reuses a certificate, then stages
  the exact hostname through Edge. The domain becomes active after the
  adapter acknowledges the publication and a local HTTPS request reaches the
  Platform using the hostname and a trusted certificate. Withdrawal requires
  the acknowledged replacement publication and a local check that the old
  HTTPS route no longer answers. If the installed
  adapter is unavailable, the hostname remains verified for a later retry.
  A deployed Traefik test verified public HTTP-01 issuance, renewal and
  withdrawal with Let’s Encrypt staging. The test client used the staging
  trust roots.

## Native App authentication ingress

A verified Project hostname and its supported Edge preview share the same
public Auth routing rules. Zelavis sends the following exact routes to the
running native App engine even when another frontend serves the site root.

| Method | Default App paths |
| --- | --- |
| `GET` | `/zelavis/login`, `/zelavis/sign-up` |
| `GET` | `/zelavis/auth-assets/identity.js`, `/zelavis/auth-assets/identity.css` |
| `GET` | `/zelavis/api/v1/auth/registration`, `/zelavis/api/v1/auth/session` |
| `POST` | `/zelavis/api/v1/auth/authenticate/password`, `/zelavis/api/v1/auth/sign-up/password`, `/zelavis/api/v1/auth/session/rotate` |
| `DELETE` | `/zelavis/api/v1/auth/session` |

App Auth responses use `Cache-Control: no-store` and auth writes have an 8 KiB
body limit. The Platform dashboard, child administrative Auth and OAuth
callback routes stay outside this public allowlist. A stopped native App
returns a site availability error. A running App engine without these pages
returns 404. Managed third-party Project sites retain their own authentication.
