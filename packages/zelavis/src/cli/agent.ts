/**
 * `zelavis agent` — run the Agent as its own process.
 *
 * Deliberately a separate command rather than something `zelavis serve` starts.
 * An Agent the Platform spawns shares the Platform's fate, which is the exact
 * property this is meant to break: the operator supervises it — systemd,
 * launchd, whatever the host uses — so a Platform restart is not a restart of
 * everything the Platform was running.
 *
 * It runs until it is signalled, then stops the processes it owns. Stopping
 * them is the right shutdown behaviour for a supervisor going away on purpose:
 * a supervisor that exits leaving unsupervised children behind is the leak
 * this whole line of work exists to close.
 */
import { join, resolve } from "node:path";

import { createAgentProcessServer } from "../adapters/_agent-ipc.js";
import { createLocalAgentProcessRunner } from "../adapters/_agent-process-runner.js";

export interface RunAgentCommandOptions {
  /** Defaults to the same `.zelavis` directory the Platform uses. */
  readonly dataDirectory?: string;
  /** Injected by tests; production waits for a signal. */
  readonly signal?: AbortSignal;
}

export async function runAgentCommand(
  options: RunAgentCommandOptions = {},
): Promise<void> {
  const dataDirectory = resolve(options.dataDirectory ?? ".zelavis");
  const endpointDirectory = join(dataDirectory, "agent");

  const runner = createLocalAgentProcessRunner({
    // The same records the in-process runner keeps, in the same place, so an
    // installation that switches between the two does not lose track of what
    // the other started.
    stateDirectory: join(dataDirectory, "projects", ".agent-processes"),
  });

  // Anything a previous Agent or Platform left running is stopped before this
  // one starts accepting work, so the first Project start does not race a
  // leftover holding its port.
  const reclaimed = (await runner.reclaim?.()) ?? 0;
  if (reclaimed > 0) {
    console.log(`Reclaimed ${reclaimed} process(es) left by an earlier run.`);
  }

  const server = await createAgentProcessServer({
    directory: endpointDirectory,
    runner,
  });

  console.log(`Zelavis Agent listening on ${server.socketPath}`);

  let closing: Promise<void> | undefined;
  const shutdown = () => {
    closing ??= server.close().then(
      () => undefined,
      (error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      },
    );
    return closing;
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  if (options.signal) {
    if (options.signal.aborted) {
      await shutdown();
      return;
    }
    await new Promise<void>((resolveAborted) => {
      options.signal!.addEventListener("abort", () => resolveAborted(), {
        once: true,
      });
    });
    await shutdown();
    return;
  }

  await new Promise<void>((resolveClosed) => {
    const poll = setInterval(() => {
      if (!closing) return;
      clearInterval(poll);
      void closing.then(() => resolveClosed());
    }, 100);
  });
}
