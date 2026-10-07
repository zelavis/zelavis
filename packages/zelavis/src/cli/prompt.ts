/**
 * Terminal secret entry.
 *
 * Passwords are read here rather than accepted as options on purpose. A
 * `--password` flag lands in shell history and, for the lifetime of the
 * process, in the system process list where any local user can read it — a
 * real leak for the one credential that owns the whole Platform. The only
 * two ways in are an interactive prompt with the echo turned off and an
 * explicit `--password-stdin` pipe.
 */
import { createInterface } from "node:readline";
import { Effect, Stream } from "effect";
import { IntegrationFailure, present } from "../core/runtime/effect-boundary.js";

type StdIn = NodeJS.ReadableStream & { isTTY?: boolean };

export function readAllStdin(
  stream: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
  return present(Stream.fromAsyncIterable(stream as AsyncIterable<unknown>, (cause) => new IntegrationFailure(cause)).pipe(
    Stream.runCollect,
    // A trailing newline is an artifact of the pipe, not part of the secret.
    Effect.map((chunks) => Buffer.concat(chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))))
      .toString("utf8").replace(/\r?\n$/u, "")),
  ));
}

export function promptSecret(
  question: string,
  streams: { input?: StdIn; output?: NodeJS.WriteStream } = {},
): Promise<string> {
  return present(Effect.gen(function* (): Effect.fn.Return<string, IntegrationFailure> {
  const input = streams.input ?? (process.stdin as StdIn);
  const output = streams.output ?? process.stdout;

  if (!input.isTTY) {
    return yield* Effect.fail(new IntegrationFailure(new Error(
      "A password is required but the terminal is not interactive. Pipe it with --password-stdin.",
    )));
  }

  const rl = createInterface({ input, output, terminal: true });
  // readline echoes typed characters; muting the output stream it writes to is
  // what keeps the password off the screen and out of any scrollback.
  let muted = false;
  const write = output.write.bind(output);
  (output as { write: NodeJS.WriteStream["write"] }).write = ((
    chunk: string | Uint8Array,
    ...rest: unknown[]
  ) =>
    muted
      ? true
      : (write as (...args: unknown[]) => boolean)(chunk, ...rest)) as
    NodeJS.WriteStream["write"];

  return yield* Effect.callback<string>((resume) => {
    rl.question(question, (value) => resume(Effect.succeed(value)));
    muted = true;
  }).pipe(Effect.ensuring(Effect.sync(() => {
    muted = false;
    (output as { write: NodeJS.WriteStream["write"] }).write = write;
    output.write("\n");
    rl.close();
  })));
  }));
}
