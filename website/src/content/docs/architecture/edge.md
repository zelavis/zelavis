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
3. Choose **Verify DNS** once your DNS provider has published the TXT record.
   The challenge expires after 24 hours. The complete TXT record name must fit
   DNS length limits. Generate a fresh challenge in Domains if it expires, and
   wait 30 seconds between TXT checks on the same domain.
4. Choose **Open site** once the domain is active. Retry activation from the
   same domain entry if ingress or certificate issuance is pending.
5. Choose **Remove domain** to withdraw the route. Project deletion also
   withdraws its domains. For externally terminated TLS, remove the external
   proxy's hostname mapping when disconnecting the domain.

Zelavis reads the TXT record from the zone's own authoritative nameservers,
not through a caching resolver. It finds the zone from the SOA in the answer
for `_zelavis-challenge.<hostname>`, so a hostname that is a CNAME into another
provider's zone, or one in a delegated subzone, is checked in its own zone. A
check made before the record existed is therefore not cached: the next check
sees the record as soon as the provider serves it. Only an authoritative answer
counts; when no nameserver of the zone answers, Domains reports that DNS is
unavailable rather than that the record is missing. Limits:

- A CNAME at `_zelavis-challenge.<hostname>` is not followed. Create the TXT
  record at that exact name, not a delegation to another verification name.
- DNSSEC signatures are not validated.
- A zone delegated so recently that the server's resolver still holds the
  parent's negative answer reports DNS as unavailable until that answer expires.
- A verified domain is not checked again later. Removing the TXT record after
  verification does not withdraw the domain; remove it in Domains.

On November 17, 2026, a disposable VPS run against `zelavis.com` verified a
real TXT record through authoritative DNS while Google Public DNS still
returned its cached negative answer. The run used the packed working-tree
candidate based on `0e4548dbcc`; `pnpm release:qualify:domains` repeats the proof.

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

## DNS automation and wildcard certificates

An operator can connect a DNS provider so Zelavis manages records in the
operator's own zones: ACME DNS-01 (and with it wildcard certificates) and
**hosted subdomains**, where a customer takes `shop.apps.example.com` under an
operator zone without creating any DNS record. The
[DNS automation guide](../guides/dns-automation.md) walks through it.

- **Providers.** Core owns the DNS provider contract (`zelavis/edge/dns-provider`).
  First-party drivers live behind the adapter boundary and are handed to the
  composition by the host adapter: Cloudflare under Node
  (`packages/zelavis/src/adapters/_dns-cloudflare.ts`). A plugin adds another by
  declaring `zelavis/edge:dns` and exporting `service.dnsProviders`
  (`defineDnsProviders`); a plugin provider named like a built-in one is refused
  (`dns_provider_conflict` in the Platform log), never used in its place.
- **Connections** keep one provider's credentials, checked against the provider
  first, encrypted with a key bound to that provider, never returned. Every
  provider call is bounded (ten seconds, four at a time per provider) and
  logged as `edge.dns.call` with provider, operation, zone and outcome, never a
  credential. Connections, zones and wildcard certificates are Platform Edge
  authority: read with `server.edge.view`, changed with `server.edge.manage`.
- **Adopted zones** name an apex Zelavis manages (the provider zone itself or a
  name below it), whether Projects may take a subdomain one label below it,
  and the A/AAAA addresses (two each) or the one CNAME those subdomains point
  at. At most 50 zones. A zone cannot be released while a Project domain holds
  a hostname under it, nor a connection deleted while a zone uses it.
- **DNS-01.** A wildcard (`*.` plus an exact hostname) is issued only through
  DNS-01. For each authorization Zelavis records a checkpoint, creates the TXT
  at `_acme-challenge.<name>` (TTL 60) in the adopted zone covering it, waits
  (every 5 s, at most 120 s) until every authoritative nameserver of the zone
  serves the value, then asks the CA to validate, and removes the record by its
  id afterwards. A record an interrupted order left behind is removed the next
  time the Platform starts, by its id or, if the id was never recorded, by its
  exact value. Renewal reorders a wildcard through DNS-01 on its own.
- **Hosted subdomains** (`dns: "automatic"` when adding a Project domain,
  managed TLS only) need no TXT proof: the operator's zone owns the name. Edge
  claims the hostname, creates its address records (TTL 300) and persists each
  record id on the domain before going on, and serves it under the zone's
  wildcard certificate, ordering that first when the zone has none. Removing
  the domain or deleting its Project withdraws the route, deletes exactly those
  records by id (and any it made without recording one), then releases the
  hostname. Another Project cannot take a claimed name.
- The wildcard's private key stays in this Platform's Edge store; nothing
  distributes it to other servers.

| HTTP (under the API base) | Access | SDK | CLI |
| --- | --- | --- | --- |
| `GET /runtime/edge/dns/providers` | `server.edge.view` | `client.edge.dns.providers()` | `zelavis edge dns-providers` |
| `PUT /runtime/edge/dns/connections/:provider` | `server.edge.manage` | `client.edge.dns.connect(provider, input)` | `zelavis edge dns-connect PROVIDER --data JSON` |
| `DELETE /runtime/edge/dns/connections/:provider` | `server.edge.manage` | `client.edge.dns.disconnect(provider)` | `zelavis edge dns-disconnect PROVIDER` |
| `GET /runtime/edge/dns/connections/:provider/zones` | `server.edge.manage` | `client.edge.dns.providerZones(provider, cursor?)` | `zelavis edge dns-provider-zones PROVIDER [--cursor C]` |
| `GET /runtime/edge/dns/zones` | `server.edge.view` | `client.edge.dns.zones()` | `zelavis edge dns-zones` |
| `PUT /runtime/edge/dns/zones/:apex` | `server.edge.manage` | `client.edge.dns.adoptZone(apex, input)` | `zelavis edge dns-adopt-zone APEX --data JSON` |
| `DELETE /runtime/edge/dns/zones/:apex` | `server.edge.manage` | `client.edge.dns.releaseZone(apex)` | `zelavis edge dns-release-zone APEX` |
| `POST /runtime/edge/dns/zones/:apex/wildcard-certificate` | `server.edge.manage` | `client.edge.dns.orderWildcard(apex)` | `zelavis edge dns-wildcard APEX` |
| `GET /runtime/projects/:id/domains/hosted-zones` | `project.domains.manage` | `client.projects.hostedZones(id)` | `zelavis projects hosted-zones ID` |

Limits: customer-owned DNS connections and automatic records in customer zones
are not supported; hosted subdomains are exactly one label below an adopted
zone; the zone's wildcard is ordered while the customer's request waits.

The November 17, 2026 qualification used real Cloudflare records on
`zelavis.com`, deployed Traefik and Let's Encrypt staging. It passed HTTP-01,
DNS-01 wildcard issuance and automatic subdomain routing; an off-host client
verified both staging certificate chains with trust confined to that client.
Cleanup removed the run's records, units, address and redirects, and existing
production processes kept their PIDs. Public CA production issuance remains
unqualified.

## Native App authentication ingress

A verified Project hostname and its supported Edge preview share the same
public Auth routing rules. Zelavis sends the following exact routes to the
running native App engine even when another frontend serves the site root.

| Kind | Default App paths |
| --- | --- |
| Pages (`GET`) | `/zelavis/login`, `/zelavis/sign-up`, `/zelavis/forgot-password`, `/zelavis/reset-password`, `/zelavis/verify-email`, `/zelavis/change-email`, `/zelavis/mfa`, `/zelavis/oauth/callback`, `/zelavis/invitation`, `/zelavis/account` and its `passkeys`, `two-factor`, `emails`, `password` and `sessions` pages |
| Assets (`GET`) | `/zelavis/auth-assets/identity.js`, `/zelavis/auth-assets/identity.css` |
| Auth API | Every route under `/zelavis/api/v1/auth/` that needs no permission: session, refresh, sessions, JWKS, methods, registration status, username and password, email and password (sign-up, sign-in, change password, change email, recovery), added emails, OAuth start, callback and redeem, passkey sign-up, sign-in and management, MFA, and invitation acceptance |

Routes that need a permission (settings, connections, administration) are never
public; an operator reaches them through the Project Gateway. An App still
locked to a published engine keeps its own earlier password and session routes
until its explicit upgrade.

App Auth responses use `Cache-Control: no-store` and auth writes have an 8 KiB
body limit. The Platform dashboard and child administrative Auth routes stay
outside this public allowlist. A stopped native App
returns a site availability error. A running App engine without these pages
returns 404. Managed third-party Project sites retain their own authentication.
