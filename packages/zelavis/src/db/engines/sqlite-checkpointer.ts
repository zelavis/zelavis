import { Worker } from "node:worker_threads";
import { Duration, Effect, type Scope } from "effect";
import type { CheckpointReply, CheckpointRequest } from "./sqlite-checkpoint-worker.js";

/** How long closing a file waits for the checkpointer to let go of it before carrying on without it. */
const CLOSE_TIMEOUT = Duration.seconds(5);

interface Checkpointer {
  readonly worker: Worker;
  /** Files registered and not yet closed. */
  files: number;
  /** Closes waiting for the worker's answer. */
  readonly closing: Map<number, () => void>;
  alive: boolean;
}

/**
 * The process's one checkpoint thread (see `sqlite-checkpoint-worker.ts`): made when the first file is registered, ended
 * by the worker itself once the last one is closed, so an idle process runs no extra thread. It never keeps a process
 * alive except while a close is waiting for its answer.
 */
let current: Checkpointer | undefined;
let nextId = 0;

const warn = (message: string) => Effect.runFork(Effect.logWarning(message));

const make = (): Checkpointer => {
  // No inherited Node flags: the thread imports only Node's own modules, and a flag the parent was started with can be
  // one a worker file refuses (`--input-type` stops it starting at all).
  const worker = new Worker(new URL("./sqlite-checkpoint-worker.js", import.meta.url), { execArgv: [] });
  const made: Checkpointer = { worker, files: 0, closing: new Map(), alive: true };
  const ended = (why: string | undefined) => {
    if (!made.alive) return;
    made.alive = false;
    if (current === made) current = undefined;
    for (const done of made.closing.values()) done();
    made.closing.clear();
    // Ending with nothing registered is the worker's own way of finishing; anything else leaves the files it had to
    // SQLite's automatic checkpoint, which the engine keeps on as a backstop.
    if (why !== undefined && made.files > 0) warn(`The SQLite checkpoint thread stopped (${why}); its ${made.files} files fall back to SQLite's own checkpoints.`);
  };
  worker.on("message", (reply: CheckpointReply) => {
    if (reply.op === "failed") {
      warn(`Checkpointing a SQLite file in the background failed; SQLite's own checkpoint still bounds its log: ${reply.reason}`);
      return;
    }
    const done = made.closing.get(reply.id);
    made.closing.delete(reply.id);
    done?.();
    if (made.closing.size === 0) worker.unref();
  });
  worker.on("error", (cause: Error) => ended(cause.message));
  worker.on("exit", (code) => ended(made.files > 0 ? `exit code ${code}` : undefined));
  worker.unref();
  return made;
};

/**
 * Checkpoints `file` off the main thread for the life of the scope. Closing the scope waits, at most a few seconds, for
 * the worker to close its connection to the file, so the file can be closed and removed once it has.
 */
export const checkpointInBackground = (file: string, power: boolean): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(register(file, power), (stop) => stop).pipe(Effect.asVoid);

const register = (file: string, power: boolean): Effect.Effect<Effect.Effect<void>> =>
  Effect.sync(() => {
    const checkpointer = current?.alive === true ? current : (current = make());
    const id = nextId++;
    checkpointer.files += 1;
    checkpointer.worker.postMessage({ op: "open", id, file, power } satisfies CheckpointRequest);
    let stopped = false;
    return Effect.suspend(() => {
      if (stopped) return Effect.void;
      stopped = true;
      checkpointer.files -= 1;
      // The worker ends itself after its last file closes: the next file gets a new one.
      if (checkpointer.files === 0 && current === checkpointer) current = undefined;
      if (!checkpointer.alive) return Effect.void;
      return Effect.callback<void>((resume) => {
        checkpointer.closing.set(id, () => resume(Effect.void));
        checkpointer.worker.ref();
        checkpointer.worker.postMessage({ op: "close", id } satisfies CheckpointRequest);
      }).pipe(Effect.timeoutOrElse({
        duration: CLOSE_TIMEOUT,
        orElse: () => Effect.sync(() => {
          checkpointer.closing.delete(id);
          if (checkpointer.closing.size === 0) checkpointer.worker.unref();
        }).pipe(
          Effect.andThen(Effect.logWarning(`The SQLite checkpoint thread did not let go of ${file} within ${Duration.format(CLOSE_TIMEOUT)}.`)),
        ),
      }));
    });
  });
