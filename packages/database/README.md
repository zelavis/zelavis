# @zelavis/database

`@zelavis/database` provides the core database contracts and document primitives for Zelavis.

The package is intentionally document-first, but not document-only. SQL is represented as an optional driver capability so SQLite-compatible integrations can expose raw SQL without forcing every runtime to support it.

## Scope

- Tenant-aware document collections.
- In-memory driver for local development and tests.
- Optional SQL capability contract for SQLite-compatible integrations.
- Server service routes through the existing `@zelavis/server` service contract, with documents exposed as a nested service.

## Non-goals for the first slice

- No built-in SQLite dependency in the core package.
- No `unstorage` dependency.
- No schema expression parser.
- No replication, offline sync, or distributed transactions.

Platform integrations should provide durable database drivers later, for example:

- `@zelavis/integration-node` can supply a Node SQLite driver, likely using `better-sqlite3`.
- `@zelavis/integration-cloudflare` can supply a D1 driver.
- `@zelavis/integration-turso` can supply a libSQL/Turso driver.

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

await zelavisServer({
  services: [databaseService(database)],
  integration,
});
```

Core services and extension services should use the same Zelavis service contract. A future Zelavis runtime may enable the database by default, but the database service should remain replaceable and disableable.
