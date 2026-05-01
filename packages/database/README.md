# @zelavis/database

`@zelavis/database` provides the core database contracts and document primitives for Zelavis.

The package is now event-first internally. Document APIs remain the main ergonomic surface, but writes append events and reads come from projections. SQL is still an optional driver capability so SQLite-compatible adapters can expose raw SQL without forcing every runtime to support it.

The document read model is the first built-in projection. A projection registry contract now exists so future derived models can be introduced explicitly instead of being hidden behind adapter-specific behavior.

The first time-series slice is now also present as a public contract. Series definitions can declare projection references, event-source filters, mapper functions, and optional definition versions. In-memory queries derive points from the event stream directly, while SQLite-backed drivers can persist mapped samples and query them incrementally.

## Scope

- Tenant-aware document collections.
- Event log contract plus projection contract.
- Collection schema registry and write-time validation.
- In-memory driver for local development and tests.
- Optional SQL capability contract for SQLite-compatible adapters.
- Server service routes through the existing `@zelavis/server` service contract, with documents exposed as a nested service.

## Non-goals for the first slice

- No built-in SQLite dependency in the core package.
- No `unstorage` dependency.
- No replication, offline sync, or distributed transactions.

Platform adapters should provide durable database drivers later, for example:

- `@zelavis/database-bun-sqlite` supplies a Bun SQLite driver using the built-in `bun:sqlite` module.
- `@zelavis/database-node-sqlite` supplies a Node SQLite driver using `better-sqlite3`.
- `@zelavis/adapter-cloudflare` can supply a D1 driver.
- `@zelavis/adapter-turso` can supply a libSQL/Turso driver.

## Usage

```ts
import { createDatabase, databaseService } from "@zelavis/database";
import { zelavisServer } from "@zelavis/server";

const database = await createDatabase();

await database.documents.createCollection({
  name: "products",
});

const product = await database.documents.insert({
  collection: "products",
  data: {
    name: "T-shirt",
    status: "published",
  },
});

const published = await database.documents.findMany({
  collection: "products",
  where: [{ path: "status", value: "published" }],
});

const events = await database.events.read({
  collection: "products",
});

await database.schemas.register({
  collection: "products",
  version: 1,
  activate: true,
  document: {
    type: "object",
    additionalProperties: false,
    required: ["name", "price"],
    properties: {
      name: { type: "string", minLength: 1 },
      price: { type: "number", minimum: 0 },
    },
  },
});

await zelavisServer({
  services: [databaseService(database)],
});
```

Each `DatabaseDocument` now also carries a `schemaVersion`, which is stored on the event stream and projection rows. If a collection has an active schema, inserts and updates are validated before events are appended.

The `database.projections` API currently exposes the built-in `documents` projection and allows registering additional projection definitions as part of the public contract. Custom projection execution and persistent rebuild orchestration are still future work.

The `database.timeseries` API currently supports defining and listing named time-series definitions, validating optional projection references, and executing `range()` / `aggregate()` for mapped series. In-memory drivers replay events directly. SQLite-backed drivers persist mapped samples, sync forward from event checkpoints, and rebuild stored samples when the series `version` changes.

Core services and extension services should use the same Zelavis service contract. A future Zelavis runtime may enable the database by default, but the database service should remain replaceable and disableable.
