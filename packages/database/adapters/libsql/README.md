# @zelavis/database-libsql

libSQL / Turso adapter for `@zelavis/database`.

Built on top of [`@libsql/client`](https://www.npmjs.com/package/@libsql/client) and the shared SQLite-compatible driver in `@zelavis/database`.

## Install

```bash
pnpm add @zelavis/database-libsql @libsql/client
```

## Usage

### Local file

```ts
import { createLibsqlDatabase } from "@zelavis/database-libsql";

const database = await createLibsqlDatabase({
  url: "file:./.zelavis/zelavis.sqlite",
});
```

### Turso (or any libSQL server)

```ts
import { createLibsqlDatabase } from "@zelavis/database-libsql";

const database = await createLibsqlDatabase({
  url: process.env.TURSO_URL!,
  authToken: process.env.TURSO_TOKEN,
});
```

### In-memory (tests)

```ts
const database = await createLibsqlDatabase({ url: ":memory:" });
```

## How it works

This adapter is a ~150-line shim. All the real database logic — collections, documents, events, schemas, time-series, idempotency, transactional appends — lives in the shared `createSqliteCompatibleDriver` core in `@zelavis/database`. The adapter only translates between `@libsql/client`'s API and the shared `SqliteGateway` interface.

The same shared core also backs `@zelavis/database-node-sqlite`, `@zelavis/database-bun-sqlite`, and `@zelavis/database-cloudflare-d1`.

## Transactions

libSQL supports interactive transactions through `client.transaction()`. The adapter uses this so the shared driver's atomic event-append logic works end-to-end without falling back to deferred-write semantics.
