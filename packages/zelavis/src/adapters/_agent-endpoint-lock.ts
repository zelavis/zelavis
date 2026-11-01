import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { evaluate, integration } from "../core/runtime/effect-boundary.js";

/** A kernel write lock, acquired before token or socket mutation. Different
 * process-record roots still cannot steal the same live daemon endpoint. */
export const acquireAgentEndpointLock = Effect.fn("AgentEndpoint.lock")(function* (directory: string) {
  yield* integration(() => mkdir(directory, { recursive: true, mode: 0o700 }));
  const stats = yield* integration(() => lstat(directory));
  yield* evaluate(() => {
    if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== process.getuid?.()) throw new Error("Agent endpoint must be an owned real directory.");
  });
  const path = join(directory, "agent.lock");
  yield* Effect.acquireUseRelease(integration(() => open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)),
    file => Effect.gen(function* () {
      const stats = yield* integration(() => file.stat());
      yield* evaluate(() => { if (!stats.isFile() || stats.uid !== process.getuid?.() || (stats.mode & 0o077) !== 0) throw new Error("Agent lock must be an owned private regular file."); });
    }), file => integration(() => file.close()).pipe(Effect.orDie));
  return yield* evaluate(() => {
    const guard = new DatabaseSync(path);
    try { guard.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); return guard; }
    catch (cause) { guard.close(); throw cause; }
  });
});
