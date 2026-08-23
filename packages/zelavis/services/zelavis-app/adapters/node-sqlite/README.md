# @zelavis/app-db-node-sqlite

`@zelavis/app-db-node-sqlite` provides a Node-only SQLite driver for `@zelavis/app/db` using `better-sqlite3`.

It exists so the database core can stay runtime-neutral while Node applications get a durable local driver today.

## Usage

```ts
import { Zelavis } from "zelavis";
import { createBetterSqlite3DatabaseDriver } from "@zelavis/app-db-node-sqlite";

const zv = new Zelavis({
  coreServices: {
    database: {
      driver: createBetterSqlite3DatabaseDriver({
        filename: "./.zelavis/zelavis.sqlite",
      }),
    },
  },
});
```

## Why this exists

- `@zelavis/app/db` stays dependency-free and runtime-neutral
- Node gets a durable SQLite-backed driver now
- future Node standard SQL APIs can land in a separate adapter without redesigning core
