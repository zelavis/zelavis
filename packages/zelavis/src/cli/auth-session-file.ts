import { constants } from "node:fs";
import { open } from "node:fs/promises";
import * as Effect from "effect/Effect";
import { evaluate, integration, present, unwrapIntegrationResult } from "../core/runtime/effect-boundary.js";
import type { AuthTokenStorage } from "../sdk/auth-session.js";

/** A private session file shared by successive CLI invocations. SQLite releases the writer reservation on process exit. */
export function withAuthSessionFile<A>(filename: string, run: (storage: AuthTokenStorage) => Promise<A>): Promise<A> {
  return present(Effect.scoped(Effect.gen(function* () {
    yield* Effect.acquireUseRelease(
      integration(() => open(filename, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)),
      file => integration(() => file.stat()).pipe(Effect.flatMap(stat => evaluate(() => {
        if (!stat.isFile() || (process.getuid !== undefined && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
          throw new Error("The Auth session file must be a regular file readable and writable only by its owner.");
        }
      }))),
      file => integration(() => file.close()).pipe(Effect.orDie),
    );
    const { DatabaseSync } = yield* integration(() => import("node:sqlite"));
    const database = yield* Effect.acquireRelease(evaluate(() => new DatabaseSync(filename)), db => Effect.sync(() => db.close()));
    yield* evaluate(() => {
      database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      database.exec("CREATE TABLE IF NOT EXISTS auth_sessions (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    });
    const read = database.prepare("SELECT value FROM auth_sessions WHERE key = ?");
    const write = database.prepare("INSERT OR REPLACE INTO auth_sessions (key, value) VALUES (?, ?)");
    const remove = database.prepare("DELETE FROM auth_sessions WHERE key = ?");
    const storage: AuthTokenStorage = {
      getItem: key => {
        const value = read.get(key)?.value;
        return typeof value === "string" ? value : undefined;
      },
      setItem: (key, value) => { write.run(key, value); },
      removeItem: key => { remove.run(key); },
    };
    // A successful refresh must be stored even if the subsequent command returned an error.
    const result = yield* Effect.result(integration(() => run(storage)));
    yield* evaluate(() => database.exec("COMMIT"));
    return unwrapIntegrationResult(result);
  })));
}
