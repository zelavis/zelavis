#!/usr/bin/env node
import { Effect } from "effect";
import { maintainStorage } from "./github-storage-maintenance.mjs";
const mode = process.argv[2];
if (process.argv.length !== 3 || !["check", "clean"].includes(mode)) {
  console.error("Usage: pnpm github:storage:check | pnpm github:storage:clean");
  process.exitCode = 1;
} else {
  Effect.runPromise(maintainStorage({ mode }).pipe(
    Effect.tap((result) => Effect.sync(() => console.log(JSON.stringify(result, null, 2)))),
    Effect.catch((error) => Effect.sync(() => { console.error(error.message); process.exitCode = 1; })),
  ));
}
