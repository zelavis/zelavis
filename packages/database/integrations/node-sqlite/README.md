# @zelavis/database-node-sqlite

`@zelavis/database-node-sqlite` provides a Node-only SQLite driver for `@zelavis/database` using `better-sqlite3`.

It exists so the database core can stay runtime-neutral while Node applications get a durable local driver today.

## Usage

```ts
import { zelavis } from "zelavis";
import { createBetterSqlite3DatabaseDriver } from "@zelavis/database-node-sqlite";

const runtime = await zelavis({
  coreServices: {
    database: {
      driver: createBetterSqlite3DatabaseDriver({
        filename: "./.data/zelavis.sqlite",
      }),
    },
  },
});
```

## Why this exists

- `@zelavis/database` stays dependency-free and runtime-neutral
- Node gets a durable SQLite-backed driver now
- future Node standard SQL APIs can land in a separate integration without redesigning core
