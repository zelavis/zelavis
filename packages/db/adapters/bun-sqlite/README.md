# @zelavis/db-bun-sqlite

`@zelavis/db-bun-sqlite` provides a Bun-only SQLite driver for `@zelavis/db` using Bun's built-in `bun:sqlite` module.

It exists so the database core can stay runtime-neutral while Bun applications get a durable local driver without pulling in a third-party native dependency.

## Usage

```ts
import { zelavis } from "zelavis";
import { createBunSqliteDatabaseDriver } from "@zelavis/db-bun-sqlite";

const runtime = await zelavis({
  coreServices: {
    database: {
      driver: createBunSqliteDatabaseDriver({
        filename: "./.data/zelavis.sqlite",
      }),
    },
  },
});
```

## Why this exists

- `@zelavis/db` stays dependency-free and runtime-neutral
- Bun gets a durable SQLite-backed driver through `bun:sqlite`
- Bun does not need a dedicated HTTP adapter for `Bun.serve()` because the runtime is already fetch-native
