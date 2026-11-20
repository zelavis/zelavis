---
layout: docs
title: "Domain Registration"
---

# Domain Registration

Use **Server → Domains → Registrar** to register, transfer in and renew domains
with your own registrar account. The Node adapter includes Namecheap. Other
registrars can be supplied by plugins through `zelavis/edge:registrar`.
This is an operator capability: customer domain resale is not available.
Buying a domain does not create a DNS zone or bind it to a Project. Configure
[DNS automation](/guides/dns-automation/) and [Project hostnames](/architecture/edge/#connect-a-project-hostname)
separately.

## Permissions and account

Inventory, provider listings and order reads require **system-scoped**
`server.domains.view`. Connection, contact, availability, quote, purchase and
nameserver operations require `server.domains.purchase`. Owners have both;
other accounts need explicit grants. Grant both to use the complete dashboard
section. A Project grant never authorizes registrar operations.

Select Namecheap and enter its API user, API key, account username and
whitelisted outgoing IPv4 address. Use an account dedicated to Zelavis: its API
key can manage domains and spend the account balance. Credentials are checked
before being encrypted in the Platform System Store; they are never returned.
Changing a connection requires its current `revision` as `expectedRevision`
when you want to refuse concurrent replacement. The dashboard always sends it.

**Sandbox** selects Namecheap's separate test account and API endpoint. It is
on by default in the dashboard. Live mode spends your real registrar balance.
The built-in driver has local XML API and browser coverage. On November 17,
2026, its live sandbox qualification passed availability/pricing, registration,
renewal and account inventory checks using sandbox test credit. Production
registrar purchases remain unqualified. Namecheap's
[API documentation](https://www.namecheap.com/support/api/methods/) describes
account access and supported TLDs.

## Registrant contact

Save the default contact before registering. Namecheap receives it as the
registrant, administrative, technical and billing contact. Use a two-letter
uppercase country code and a phone such as `+1.5555550100`. Optional organization
and second address lines can be omitted. TLD-specific requirements beyond this
profile may cause the registrar to refuse a registration.

The profile is encrypted at rest and returned only by the purchase-authorized
contact endpoint. It does not enter order records, audit logs or provider error
messages. Credentials and transfer authorization codes never enter responses.

## Quote and confirm

Search for a lower-case ASCII domain, choose register, transfer or renew and
request a quote. Amounts are decimal strings; a quote is the total for the
requested duration. A purchase dialog shows the domain, operation, duration,
account mode and total. Type the domain exactly to enable confirmation.
Namecheap transfers add exactly one year. Premium registration and renewal are
quoted for that specific domain and support one year; premium transfers and
premium EAP registration are refused by the driver.

```ts
const quote = await client.registrar.quote({
  domain: "example.com", kind: "register", years: 1,
});
const order = await client.registrar.order({
  kind: "register", domain: "example.com", years: 1,
  confirm: quote, idempotencyKey: crypto.randomUUID(),
});
```

The server reads the price again before submission. A mismatch returns
`409 price_changed` and the current `price`, without creating a purchase.
Obtain and confirm a new quote. A transfer also carries `authCode`; it is used
only for that call and never stored. Reloading a transfer dialog requires
entering the code again.

For the CLI, `zelavis registrar check DOMAIN...` reads availability and the
one-year registration price. `zelavis registrar quote --data JSON` quotes an
exact operation and duration; `zelavis registrar order --data JSON` submits
that quote with an idempotency key. All commands support `--url` and `--json`.
The full [operation map](/api/platform-operations/#registrar) lists the
SDK, HTTP and CLI equivalents.

## Order recovery

An idempotency key names one immutable intent. Repeating it returns the same
order; changing its domain, operation, duration, confirmed price or principal
is refused. Keep the same key after a network error. The dashboard stores its
key in `?order=` before submission, so a reload cannot create a second order
for that intent.

Orders move through `requested`, `submitting`, then `completed`, `failed`,
`unknown` or `pending_transfer`. A definite refusal is `failed`; an interrupted
submission or unusable receipt is `unknown`. No uncertain order is ever
submitted again automatically. Restart recovery also repairs the gap between
claiming a key and creating its order without making a purchase.

The Platform checks at most 20 active orders per pass, starting on startup and
then waiting 60 seconds between passes. It confirms registration or a transfer
with the registrar's ownership record, a renewal with an expiry later than its
recorded previous expiry, and a pending transfer with its transfer status.
A registration reported unowned and available is marked failed. Failed checks
back off to at most 24 hours between attempts. An outcome still unconfirmed
after 24 hours remains `unknown` with a message to inspect the registrar;
elapsed time alone does not prove that no charge occurred.

An unresolved order blocks a new purchase for the same domain and replacement
or disconnection of the registrar account. Retain the original working
credentials so reconciliation can use that exact connection. If ownership,
expiry or transfer status cannot establish an outcome, there is currently no
manual resolution endpoint; the order stays blocked rather than authorizing
another spend. Inspect the registrar account before taking further action.

Only one purchase runs at a time. Admission stops at 200 active orders.
Order pages contain at most 50 entries and use `after`/`next` cursors. Renewals
are explicit; there is no automatic renewal schedule, account funding,
transfer-out, DNSSEC or privacy-settings interface.

## Sandbox qualification

After building the package, supply `NAMECHEAP_SANDBOX_API_USER`,
`NAMECHEAP_SANDBOX_API_KEY` and `NAMECHEAP_SANDBOX_CLIENT_IP` securely in the
qualification process environment, then run:

```bash
pnpm release:qualify:registrar
```

The script uses only `api.sandbox.namecheap.com`, registers a random `.com`,
renews it and finds it in the account inventory. Success prints `PASS check`,
`PASS register`, `PASS renew` and `PASS list`. Missing inputs fail before any
network request. Do not use production credentials for this check.

## A registrar plugin

Import `defineRegistrars` and the `RegistrarDefinition` type from
`zelavis/edge/registrar-provider`. Declare an ordinary plugin service with
`zelavis/edge:registrar` and `service.registrars`. Each definition provides
credential-field metadata, token guidance and a client factory. Its client
implements availability, TLD pricing, domain-specific total quotes, registration,
renewal, transfer/status, ownership, paged inventory and nameserver changes.
Purchase methods receive the confirmed quote. Built-in identities cannot be
shadowed by a plugin. Keep vendor implementation code behind the adapter or
plugin boundary; runtime-neutral Edge code knows only this contract.
