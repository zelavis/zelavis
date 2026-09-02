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

type StdIn = NodeJS.ReadableStream & { isTTY?: boolean };

export async function readAllStdin(
  stream: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  // A trailing newline is an artifact of the pipe, not part of the secret.
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/u, "");
}

export async function promptSecret(
  question: string,
  streams: { input?: StdIn; output?: NodeJS.WriteStream } = {},
): Promise<string> {
  const input = streams.input ?? (process.stdin as StdIn);
  const output = streams.output ?? process.stdout;

  if (!input.isTTY) {
    throw new Error(
      "A password is required but the terminal is not interactive. Pipe it with --password-stdin.",
    );
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

  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(question, (value) => resolve(value));
      muted = true;
    });
    return answer;
  } finally {
    muted = false;
    (output as { write: NodeJS.WriteStream["write"] }).write = write;
    output.write("\n");
    rl.close();
  }
}
