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
  --permission project.data.read \
  --permission project.data.write \
  --project app_myproduct
```

Reads and writes are separate permissions, as `project.view` and
`project.runtime.manage` are: holding one does not confer the other. A client
that only reports is granted `project.data.read` alone.

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
  where: [{ path: 'archived', value: false }],
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

### Indexing only the fields you query

By default every field of every document is indexed, so any field can be
filtered or sorted on. A collection that names the fields it queries indexes
only those, and its documents cost far less to write and store: in one
measurement, a document with 28 fields and four of them declared wrote 47%
fewer bytes per insert and took 56% less space once the log was compacted than
the same collection indexing every field.

```ts
await data.collections.create({ name: 'posts', columns: ['status', 'author', 'publishedAt'] });

// Later: index another field, or every field again.
await data.collections.setColumns('posts', ['status', 'author', 'publishedAt', 'slug']);
await data.collections.setColumns('posts', null);
```

A declared field covers everything below it, so `author` covers `author.id`.
Filtering or sorting by equality, `in`, a range or a single field on any
other field fails with `UnindexedField` (400) instead of scanning the
collection; filters checked per document, such as `ne`, still work on any
field. A reference must read a declared field. `setColumns` rewrites the
collection's documents under the new choice, so a newly added field answers
for every document once it returns. The CLI takes the same choice:
`zelavis data create-collection posts --columns status,author` and
`zelavis data set-columns posts --columns all`.

### How many documents

`count` answers how many documents a collection holds, counted from the collection's identifiers in the index without
reading any document, so it is linear in the collection and cheap beside reading it. A collection's own definition is not
one of them, and an unknown collection is a 404.

| Form | Call |
|---|---|
| HTTP | `GET /zelavis/api/v1/runtime/projects/:projectId/data/documents/collections/:collection/count` (the database's `GET …/database/documents/collections/:collection/count`) |
| SDK | `data.collections.count('posts')` |
| CLI | `zelavis data count posts --project ID` |

### Definitions, summaries, schemas and series

The rest of the database's operations are in all three forms too. Their bodies are the database's own vocabulary
(`/api/database/...` in the OpenAPI spec). In the SDK the inputs and answers (definitions, schemas, traversal, summaries, related, time series, health) are the server's own TypeScript types, so a wrong field
is a compile error; the CLI passes `--data` through and prints the database's own answer, so the three answer alike,
refusals included. In the CLI the body is `--data JSON`, and a name (an index, check, reference
or schema version) is the third argument. HTTP paths are under `/zelavis/api/v1/runtime/projects/:projectId/data/`.

| What | HTTP (`data/…`) | SDK (`data.…`) | CLI (`zelavis data … --project ID`) |
|---|---|---|---|
| Collection exists | `GET documents/collections/:c/exists` | `collections.exists(c)` | `exists c` |
| Analyzer, spatial index, embedding | `POST documents/:c/analyzer\|geometry\|embedding` | `collections.setAnalyzer\|setSpatial\|setEmbedding(c, body)` | `set-analyzer\|set-spatial\|set-embedding c --data` |
| Rewrite to today's lenses | `POST maintenance/documents/rewrite` | `collections.rewrite(c?)` | `rewrite [c]` |
| Composite indexes | `POST documents/:c/indexes`, `DELETE …/indexes/:name` | `indexes.create(c, body)`, `indexes.drop(c, name)` | `create-index c --data`, `drop-index c name` |
| Checks | `POST documents/:c/checks`, `DELETE …/checks/:name` | `checks.add`, `checks.drop` | `add-check`, `drop-check` |
| References | `POST documents/:c/references`, `DELETE …/references/:name` | `references.add`, `references.drop` | `add-reference`, `drop-reference` |
| Traversal, summaries, related | `POST documents/:c/traverse\|summarize\|summarize-by\|related` | `documents.traverse\|summarize\|summarizeBy\|related(c, body)` | `traverse\|summarize\|summarize-by\|related c --data` |
| Schemas | `GET schemas/collections`, `GET\|POST schemas/:c`, `POST …/activate\|validate` | `schemas.list\|versions\|save\|activate\|validate` | `schemas`, `schema-versions`, `save-schema`, `activate-schema c VERSION`, `validate-schema` |
| Time series | `GET timeseries/series`, `POST timeseries/:s/range\|aggregate\|windows\|moving\|histogram\|interpolate\|ingest` | `timeseries.list\|range\|aggregate\|windows\|moving\|histogram\|interpolate\|ingest` | `series`, `series-range\|aggregate\|windows\|moving\|histogram\|interpolate\|ingest s` |
| Health | `GET health` | `health()` | `health` |

The operator's read-only maintenance views (needs `database.inspect`, carried by `project.view`) are on the Project
rather than the App data client: `client.projects.systemViews(projectId, { tenantId? })` and
`client.projects.systemView(projectId, view, { tenantId?, limit?, after? })`, or
`zelavis projects system-views <id> [--view NAME] [--tenant T] [--limit N] [--after CURSOR]`.

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

### Messages with a write

`emit` records messages in the Tenant's outbox in the same transaction as the
batch, so a message exists exactly when the change it describes does. A
consumer reads them in commit order and removes what it has handled:

```ts
await data.documents.write({
  operations: [{ _tag: 'Insert', collection: 'orders', id: 'o1', data: { total: 10 } }],
  emit: [{ topic: 'order.placed', payload: { order: 'o1' } }],
});

const page = await data.outbox.read({ after: lastCursor, limit: 100 });
for (const message of page.messages) await deliver(message); // deduplicate by message.id
await data.outbox.remove(page.messages.map((message) => message.id));
lastCursor = page.cursor;
```

Delivery is at least once, so deliver idempotently by `message.id`. Reading needs
only `project.data.read`. See [Database](/api/database/#outbox) for the full
contract.

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

```http
GET /zelavis/api/v1/runtime/projects/app_myproduct/data/outbox/messages?limit=100
```

A request that names a `tenantId` other than its own is answered `403`, not
honoured.

## CLI

```bash
zelavis data collections --project app_myproduct
zelavis data insert boards --project app_myproduct --data '{"title":"Engineering"}'
zelavis data query boards --project app_myproduct --where '[{"path":"archived","value":false}]'
zelavis data get boards brd_01h... --project app_myproduct --json
zelavis data outbox --project app_myproduct --limit 100 --json
zelavis data outbox-remove --project app_myproduct --ids msg_1,msg_2
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
still need their typed surfaces. There is no general document change feed yet:
the outbox carries the messages App code emits with its writes, and the KV
change feed follows one KV namespace.
