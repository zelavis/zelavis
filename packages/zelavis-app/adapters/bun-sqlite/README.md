# @zelavis/app-db-bun-sqlite

`@zelavis/app-db-bun-sqlite` provides a Bun-only SQLite driver for `@zelavis/app/db` using Bun's built-in `bun:sqlite` module.

It exists so the database core can stay runtime-neutral while Bun applications get a durable local driver without pulling in a third-party native dependency.

## Usage

```ts
import { Zelavis } from "zelavis";
import { createBunSqliteDatabaseDriver } from "@zelavis/app-db-bun-sqlite";

const zv = new Zelavis({
  coreServices: {
    database: {
      driver: createBunSqliteDatabaseDriver({
        filename: "./.zelavis/zelavis.sqlite",
      }),
    },
  },
});
```

## Why this exists

- `@zelavis/app/db` stays dependency-free and runtime-neutral
- Bun gets a durable SQLite-backed driver through `bun:sqlite`
- Bun does not need a dedicated HTTP adapter for `Bun.serve()` because the runtime is already fetch-native
