---
title: Streaming a Tenant to an analytics store
description: Keep an analytics copy of a Tenant's documents current from its export stream, with a dependency-free consumer and no analytics engine built into Zelavis.
---

Zelavis stores a Tenant for transactions: documents that are written, read and indexed one at a time. Questions that
scan everything (revenue by month, which of three features is used most) belong in an analytics engine such as
DuckDB, ClickHouse or a warehouse, fed with a copy of the data. Zelavis does not embed one: a native analytics engine
would break the rule that the Platform has no native dependency, and the copy is better kept where the analytics runs.
What Zelavis provides is the feed: the [export stream](../../api/database/#exporting-a-tenant-as-a-stream).

## How the feed stays correct

Reading a table page by page while it is written gives a view that never existed: early pages are old, late pages are
new. The stream avoids that the way the database itself does. Each call returns a page of the Tenant's records and a page
of its event log, and you apply entries **by version**: an entry older than what you hold changes nothing, a newer one
brings the record forward. Once a page says `consistent`, what you hold is the Tenant as of one log position, and the same
cursor keeps delivering changes, in order, from there.

Until then the feed holds the Tenant's log so compaction cannot cut what it has still to read; once consistent it holds
nothing, and a consumer that is away long enough to be outrun by compaction gets a 409 and starts again from a new export.

## A consumer

`examples/analytics-feed/feed.mjs` in the repository is the
whole consumer: a single file, no dependencies, with its state as plain JSON so a restart carries on from the saved
cursor. It takes the SDK client as an argument:

```js
import { createZelavisClient } from "zelavis/sdk";
import { sync, rows, jsonLines } from "./feed.mjs";
import { readFile, writeFile } from "node:fs/promises";

const client = createZelavisClient({
  baseUrl: "https://zv.example.com",
  headers: { authorization: `Bearer ${process.env.ZELAVIS_TOKEN}` },
});
const saved = await readFile("feed.json", "utf8").then(JSON.parse, () => undefined);

const feed = await sync({
  client, projectId: "shop", tenantId: "acme", feed: saved,
  onPage: (state) => writeFile("feed.json", JSON.stringify(state)),   // survive a restart
});

await writeFile("posts.jsonl", jsonLines(feed));   // one JSON object per live document
```

`rows(feed)` gives one flat row per live document (`collection`, `id`, `version`, your fields, and `part` for a divided
Tenant). Load the file with whatever you use: DuckDB `read_json('posts.jsonl')`, ClickHouse `JSONEachRow`, a warehouse's bulk
loader. With `follow: true` the consumer keeps polling and applying changes until its `signal` aborts, which is how a live
dashboard or a replica is kept current.

The same stream is `zelavis projects export-stream` for scripts, and the HTTP route `POST …/database/tenants/:tenantId/export`
for anything else; the consumer is tested against a real database in `packages/zelavis/test/db-export-consumer.test.mjs`.

## What this is not

It is not a managed analytics product. A bundled, queryable OLAP store would be a separate, optional service fed from this
stream, never part of the Platform's core runtime. And it copies documents, not derived state: indexes, projection
checkpoints and time-series state are rebuilt by whatever reads the copy.
