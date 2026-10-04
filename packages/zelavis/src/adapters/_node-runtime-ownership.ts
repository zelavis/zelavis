import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { evaluate, integration } from "../core/runtime/effect-boundary.js";

/** All protocol workers take this kernel lock before opening any live store.
 * A supervisor PID or an acknowledged signal is never ownership proof. The
 * operating system releases this lock when a worker dies; partial activation
 * retains it until that worker is fenced, even when engine cleanup fails.
 */
export const acquireNodeRuntimeOwnership = Effect.fn("RuntimeOwnership.acquire")(function* (directory: string) {
  const root = resolve(directory);
  yield* integration(() => mkdir(root, { recursive: true, mode: 0o700 }));
  const guard = yield* evaluate(() => {
    const database = new DatabaseSync(join(root, ".runtime-owner.sqlite"));
    try { database.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); return database; }
    catch (cause) { database.close(); throw cause; }
  });
  let released = false;
  return evaluate(() => {
    if (released) return;
    guard.close();
    released = true;
  });
});

/** Acquiring the same lock proves no qualified previous worker owns stores.
 * The supervisor must also hold its journal lock throughout this proof and
 * subsequent activation. Workers independently recheck at activation.
 */
export const proveNodeRuntimeUnowned = Effect.fn("RuntimeOwnership.proveUnowned")(function* (directory: string) {
  yield* Effect.acquireUseRelease(acquireNodeRuntimeOwnership(directory), () => Effect.void, release => release.pipe(Effect.orDie));
});
