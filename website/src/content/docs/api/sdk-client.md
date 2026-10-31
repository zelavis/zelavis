---
title: SDK client
description: How the JavaScript client behaves on every operation — errors, deadlines, cancellation, retries, idempotency and pagination — the same in browsers and servers.
---

`createZelavisClient` from `zelavis/sdk` (also `zelavis/sdk/browser` and `zelavis/sdk/node`) is a typed client of the
versioned HTTP API. Every operation it offers is also an HTTP route and a CLI command; a test holds the three to that.
This page covers what every operation shares.

```ts
import { createZelavisClient } from 'zelavis/sdk';

const client = createZelavisClient({
  baseUrl: 'https://panel.example.com',
  headers: { authorization: `Bearer ${token}` },
  timeoutMs: 10_000,                 // every request's deadline
  retry: { attempts: 3 },            // only what is safe to repeat, see below
  signal: controller.signal,         // abort it to cancel everything in flight
});
```

## Errors

A request that the server answered with a failure throws `ZelavisClientHttpError`: `status`, `code` (the server's
machine-readable code when it sent one), `operation` (`METHOD path`), `message` (the server's sentence, the same one
the CLI prints) and `retryable` (true for 429, 502, 503 and 504, when a repeat may succeed). A request that never got
an answer throws `ZelavisClientTransportError`; one cancelled or past its deadline throws `ZelavisClientAbortError`
with `reason` `"cancelled"` or `"timeout"`. The CLI reports the same failures with the same sentences, and with
`--json` exits non-zero.

## Deadlines and cancellation

`timeoutMs` on the client is every request's deadline; a call's own `timeoutMs` overrides it. `signal` on the client
cancels every request in flight when aborted, and a request cancelled before it was sent is never sent. Cancelling
stops waiting; a write the server already received may still complete, which is what idempotency keys are for.

## Retries and idempotency

Retries are off unless `retry` is set, and even then only what cannot apply twice is repeated:

- GET, HEAD, PUT and DELETE requests;
- writes that carry an idempotency key (`idempotencyKey` in the body, as document writes, outbox messages and imports
  take, or an `idempotency-key` header): the server records the key in the same transaction as the change, so a
  repeat answers the first result instead of writing again.

A request is repeated when it got no answer or got 429, 502, 503 or 504, with exponential backoff and jitter from
`baseDelayMs` (200 ms by default), up to `attempts` in all. A cancellation or deadline is never retried. Out of
attempts, the last answer is thrown as usual. A write without a key is sent once: retry it yourself only if you know
it did not apply, or give it a key.

## Pagination

Listings that page answer a cursor: `next`, or `cursor` with `more`, or `after`. `pages(page)` walks any of them:

```ts
import { pages } from 'zelavis/sdk';

for await (const page of pages((after) => client.data(projectId).events.read({ after, limit: 500 }))) {
  for (const event of page.events) handle(event);
}
```

It stops at the last page, or when a cursor does not move.

## One operation, three ways, least authority

A service account that may only read one Project's data, used from each surface:

```bash
zelavis auth service-accounts create --name reporting --project shop --project-permission project.data.read --json
```

```ts
const reporting = createZelavisClient({ baseUrl, headers: { authorization: `Bearer ${serviceToken}` } });
const orders = await reporting.data('shop').documents.query('orders', { where: [{ path: 'status', value: 'paid' }], limit: 50 });
```

```bash
curl -H "authorization: Bearer $SERVICE_TOKEN" -H 'content-type: application/json' \
  -d '{"where":[{"path":"status","value":"paid"}],"limit":50}' \
  https://panel.example.com/zelavis/api/v1/runtime/projects/shop/data/documents/orders/query
```

```bash
zelavis data query orders --project shop --data '{"where":[{"path":"status","value":"paid"}],"limit":50}' --token "$SERVICE_TOKEN" --json
```

The three answer the same rows, and refuse a write the same way: the grant carries `project.data.read` only, so
`documents.insert` is a 403 through every surface.
