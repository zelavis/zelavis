---
title: DNS Automation
---
Connect a DNS provider so Zelavis can write records in your own zones: wildcard
certificates through ACME DNS-01, and hosted subdomains that customers add
without touching DNS. Customers' own domains keep the TXT proof described in
[Connect a Project hostname](../architecture/edge.md#connect-a-project-hostname).

Cloudflare is built in. Another provider can be added by a plugin (see
[A provider of your own](#a-provider-of-your-own)).

## 1. Create a token

In Cloudflare, create an API token with **Zone → DNS → Edit**, limited to the
zones Zelavis should manage. Such a token cannot change your account or other
zones. Make a token used by Zelavis alone, so revoking it affects nothing else.

## 2. Connect the provider

Open **Server → Domains**, find **Cloudflare**, paste the token and choose
**Connect Cloudflare**. Zelavis lists the token's zones once before keeping it,
so a wrong token is refused at once. The token is stored encrypted and never
shown again; to replace it, connect again.

```bash
zelavis edge dns-connect cloudflare --data '{"credentials":{"apiToken":"<token>"}}'
```

## 3. Adopt a zone

Choose **Choose a zone**, pick the provider zone, and enter the apex Zelavis
manages: the zone itself (`example.com`) or a name below it
(`apps.example.com`). Turn on hosted subdomains and give the address they
point at: up to two IPv4 and two IPv6 addresses, or one CNAME target (normally
this server's public address).

```bash
zelavis edge dns-provider-zones cloudflare
zelavis edge dns-adopt-zone apps.example.com --data '{"provider":"cloudflare","zoneId":"<zone id>","hostedSubdomains":true,"targets":{"a":["203.0.113.7"],"aaaa":[]}}'
```

## 4. Wildcard certificate

Open the zone and choose **Order wildcard certificate** (or run
`zelavis edge dns-wildcard apps.example.com`). Zelavis creates the
`_acme-challenge` TXT record, waits until every authoritative nameserver of
the zone serves it (checked every 5 seconds, for at most 2 minutes), lets the CA
validate it, and deletes the record. It renews the certificate the same way.
The private key stays on this Platform. If an order is interrupted, the
challenge record is deleted the next time the Platform starts.

You do not have to order it first: the first hosted subdomain under a zone
orders the zone's wildcard when it has none.

## 5. Hosted subdomains

A customer with `project.domains.manage` on a Project opens **Domains**,
chooses **Use apps.example.com**, enters a single label such as `shop`, and adds
it. Zelavis claims `shop.apps.example.com` for that Project, creates its A/AAAA
or CNAME records, and serves it over HTTPS under the zone's wildcard
certificate. Nobody else can take a claimed name. The customer can find the
zones on offer through `client.projects.hostedZones(id)` or
`zelavis projects hosted-zones <id>`, and add one with
`zelavis projects add-domain <id> shop.apps.example.com --tls managed --dns automatic`.

Removing the domain, or deleting the Project, withdraws its route, deletes
exactly the records Zelavis created for it, and releases the name. A zone cannot
be released while a hosted subdomain uses it, and a connection cannot be
removed while a zone uses it.

## What is not automated

- Records in a customer's own zone: customers prove their own domains with a
  TXT record.
- Names more than one label below an adopted zone.
- DNSSEC, zone hosting by Zelavis, and registrar actions.

## A provider of your own

A plugin declares the capability `zelavis/edge:dns` and exports its drivers
with `defineDnsProviders` from `zelavis/edge/dns-provider`. A driver names its
credential fields and what a token can do, and returns a client with four
calls: list zones (paged), list records by name and type, create a record, and
remove a record by id (a record already gone is success). The Platform supplies
`fetch` and an abort signal, stores the credentials, and enforces the timeouts,
concurrency and audit lines. A plugin cannot use the name of a built-in driver.

```ts
import { defineDnsProviders } from "zelavis/edge/dns-provider";

export default defineDnsProviders("@acme/dns-example", [{
  name: "exampledns",
  title: "Example DNS",
  credentials: [{ name: "token", label: "API token", secret: true }],
  tokenGuidance: "A token that can edit records in the chosen zones only.",
  createClient: (credentials, { fetch, signal }) => ({
    zones: async ({ cursor }) => ({ zones: [] }),
    records: async (zoneId, { name, type }) => [],
    create: async (zoneId, record) => ({ id: "…", ...record }),
    remove: async (zoneId, recordId) => {},
  }),
}]);
```
