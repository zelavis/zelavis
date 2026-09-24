---
title: App Data
---

An App that keeps its records in Zelavis usually does not run inside the
Platform process. A desktop client, a background worker, a CLI, or a service on
another host all need the same thing: their own Tenant's documents, over the
wire, without holding any authority over the Project those documents live in.

That is what the App data boundary is. It is the same database described in
[Database](/api/database), reached from outside as an ordinary client.

## What makes it a boundary

Two properties, and both matter:

- **The Tenant is never a parameter.** It is resolved from the authenticated
  principal, signed into the Project Gateway's authority envelope, and taken
  from there by the database service. A client cannot address another Tenant's
  records however it composes a request.
- **Data authority is not Platform authority.** `project.data.read` and
  `project.data.write` imply `database.read` and `database.write` and nothing
  else. Holding them does not let a caller start, stop, reconfigure, or inspect
  the Project runtime — which is the whole point, because the App is a tenant of
  that Project rather than its operator.

Reading or writing App data does **not** require `project.view` or
`project.runtime.manage`.

## Grant an App client its authority

An App client is an ordinary principal with a Project-scoped grant. Nothing
about it is special:

```bash
zelavis auth service-accounts create \
  --name "my-app" \
  --permission project.data.write \
  --project app_myproduct
```

`project.data.write` implies read. Grant `project.data.read` alone for a client
that only reports.

## JavaScript

```ts
import { createZelavisClient } from 'zelavis/sdk';

const zv = createZelavisClient({
  baseUrl: 'https://zelavis.example.com',
  headers: { authorization: `Bearer ${token}` },
});

const data = zv.data('app_myproduct');

await data.collections.create({ name: 'boards' });

const board = await data.documents.insert('boards', {
  data: { title: 'Engineering' },
});

const open = await data.documents.query('boards', {
  where: [{ field: 'archived', is: false }],
  limit: 20,
});
```

The Project is part of the address because there is no ambient "current
Project". The Tenant is absent because it is not the caller's to choose.

### Changing a document safely

Two clients editing one document is ordinary, so an update can carry the
version it was written against:

```ts
const updated = await data.documents.update('boards', board.id, {
  data: { title: 'Platform' },
  expectedVersion: board.version,
});
```

A stale `expectedVersion` is a conflict rather than a silent overwrite.

### Several changes as one

`write` applies a batch atomically, in the order given:

```ts
await data.documents.write({
  idempotencyKey: `archive-${board.id}`,
  operations: [
    { _tag: 'Update', collection: 'boards', id: board.id, data: { archived: true } },
    { _tag: 'Insert', collection: 'activity', data: { board: board.id, kind: 'archived' } },
  ],
});
```

`idempotencyKey` is worth reaching for over a network. A client that never sees
a response cannot tell a lost reply from a lost request; a retry carrying the
same key is answered with what the first attempt returned instead of being
applied twice.

## HTTP

Every call is a path under the Project's data route. The database service's own
paths follow it unchanged.

```http
POST /zelavis/api/v1/runtime/projects/app_myproduct/data/documents/boards
Authorization: Bearer <token>
Content-Type: application/json

{ "data": { "title": "Engineering" } }
```

```http
GET /zelavis/api/v1/runtime/projects/app_myproduct/data/documents/collections
```

A request that names a `tenantId` other than its own is answered `403`, not
honoured.

## CLI

```bash
zelavis data collections --project app_myproduct
zelavis data insert boards --project app_myproduct --data '{"title":"Engineering"}'
zelavis data query boards --project app_myproduct --where '[{"field":"archived","is":false}]'
zelavis data get boards brd_01h... --project app_myproduct --json
```

There is no `--tenant` flag. The Tenant follows from whoever the token
authenticates as.

## Operators are a different case

An operator browsing an installation's tables does name the Tenant, and should:
that is what the dashboard's database pages do. Naming a Tenant requires
`database.inspect`, which `project.view` carries. An App client holds no inspect
authority and is confined to its own records.

## What is not here yet

The data route reaches the whole database service, but only collections and
documents have a typed SDK and CLI today. Schemas, projections, time series,
search, geometry, and traversal are reachable over HTTP at the same boundary and
still need their typed surfaces. There is also no change feed: a client learns
about writes by asking.
