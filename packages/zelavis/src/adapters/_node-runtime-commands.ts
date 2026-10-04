import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import { Deferred, Effect, Fiber, Semaphore } from "effect";
import { evaluate, IntegrationFailure, type TaggedFailure } from "../core/runtime/effect-boundary.js";
import { NODE_RUNTIME_PROTOCOL } from "./_node-runtime-protocol.js";

/** Bounded control messages over the Agent-owned stdin pipe. This creates no
 * public HTTP control endpoint and grants no authority beyond that pipe.
 * Validate messages before queuing, cap pending work, and interrupt it before
 * releasing a host's resources. Secrets never appear in response events.
 */
export const serveNodeRuntimeCommands = Effect.fn("RuntimeCommands.serve")(function* (options: {
  readonly input: Readable;
  readonly emit: (value: Record<string, unknown>) => void;
  readonly command: (input: Readonly<Record<string, unknown>>) => Effect.Effect<Readonly<Record<string, unknown>>, TaggedFailure>;
  /** Acknowledgements must bypass the operation waiting for that very ack. */
  readonly acknowledge?: (input: Readonly<Record<string, unknown>>) => boolean;
}) {
  const ended = Deferred.makeUnsafe<void, TaggedFailure>();
  const mutex = Semaphore.makeUnsafe(1);
  const pending = new Set<Fiber.Fiber<void, never>>();
  const fork = Effect.runForkWith(yield* Effect.context<never>());
  const decoder = new StringDecoder("utf8");
  let buffer = "", stopped = false;
  const fail = (message: string) => {
    stopped = true;
    Deferred.doneUnsafe(ended, Effect.fail(new IntegrationFailure(new Error(message))));
  };
  const line = (source: string) => {
    if (Buffer.byteLength(source) > 64 * 1024) { fail("Runtime command bounds exceeded."); return; }
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(source);
      if (!input || Array.isArray(input) || typeof input.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.id) || typeof input.action !== "string") throw new Error();
    } catch { fail("Invalid runtime command envelope."); return; }
    if (options.acknowledge?.(input)) return;
    if (pending.size >= 32) { fail("Runtime command queue is full."); return; }
    const fiber = fork(mutex.withPermit(options.command(input)).pipe(
      Effect.match({ onSuccess: value => options.emit({ protocol: NODE_RUNTIME_PROTOCOL, id: input.id, ...value }),
        onFailure: error => options.emit({ protocol: NODE_RUNTIME_PROTOCOL, id: input.id, type: "failed", error: error.message }) }),
    ));
    pending.add(fiber);
    fiber.addObserver(() => { pending.delete(fiber); });
  };
  const data = (chunk: Buffer | string) => {
    if (stopped) return;
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let newline: number;
    while (!stopped && (newline = buffer.indexOf("\n")) !== -1) {
      const source = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      line(source);
    }
    if (Buffer.byteLength(buffer) > 64 * 1024) fail("Runtime command line exceeds its size bound.");
  };
  const end = () => {
    stopped = true;
    if (buffer.trim() || decoder.end()) fail("Runtime command pipe ended with an incomplete envelope.");
    else Deferred.doneUnsafe(ended, Effect.void);
  };
  const error = () => fail("Runtime command pipe failed.");
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    stopped = true;
    options.input.off("data", data); options.input.off("end", end); options.input.off("error", error);
    yield* Effect.forEach([...pending], Fiber.interrupt, { concurrency: 4, discard: true });
  }));
  yield* evaluate(() => { options.input.on("data", data); options.input.once("end", end); options.input.once("error", error); });
  return Deferred.await(ended);
});
