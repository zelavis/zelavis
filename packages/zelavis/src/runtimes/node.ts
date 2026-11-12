import { Effect } from "effect";
import { IntegrationFailure, integration, present, integrationValue, unwrapFailure } from "../core/runtime/effect-boundary.js";
import type { Server } from "node:http";
import { createNodeHttpServer } from "../core/runtime/node-http.js";
import type { Zelavis } from "../index.js";

export const node = true;

export interface CloseNodeServerOptions {
  gracePeriodMs?: number;
}

export function createNodeServer(zelavis: Zelavis): Promise<Server> {
    return present(Effect.gen(function* (): Effect.fn.Return<Server, IntegrationFailure> {
  const runtime = (yield* integrationValue(zelavis.runtime()));
  return (yield* integrationValue(createNodeHttpServer(runtime)));
}));
  }

export function closeNodeServer(
  server: Server,
  options: CloseNodeServerOptions = {},
): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }

  const gracePeriodMs = Math.max(0, options.gracePeriodMs ?? 10_000);
  return present(Effect.callback<void, IntegrationFailure>((resume) => {
    const forceTimer = setTimeout(() => {
      server.closeAllConnections();
    }, gracePeriodMs);

    server.close((error) => {
      clearTimeout(forceTimer);
      if (error) {
        resume(Effect.fail(new IntegrationFailure(error)));
      } else {
        resume(Effect.void);
      }
    });
    server.closeIdleConnections();
  }));
}

export interface ShutdownOnSignalsOptions {
  /** Signals that start a shutdown. Closing a terminal sends SIGHUP, so it is one. */
  signals?: readonly NodeJS.Signals[];
  /** A shutdown still running after this long is abandoned and the process exits with code 1. */
  forceAfterMs?: number;
  /** Leave the process to exit on its own instead of calling `process.exit` when shutdown ends. */
  keepAlive?: boolean;
  /** Injected for tests. */
  process?: Pick<NodeJS.Process, "on" | "off" | "exit">;
  log?: (message: string) => void;
}

/**
 * Runs `shutdown` once when the process is told to stop, and waits for it.
 *
 * A host that stops Projects and releases their placements in `close()` needs
 * that to finish. A handler registered with `process.once` does not: the first
 * signal starts the shutdown and removes the handler, so a second signal, which
 * a terminal's Ctrl-C and a dev script that forwards it both send, takes Node's
 * default action and kills the process half way through. Here every signal after
 * the first is ignored while the shutdown runs, and only one that never finishes
 * is cut off.
 */
export function shutdownOnSignals(
  shutdown: () => Promise<void>,
  options: ShutdownOnSignalsOptions = {},
): { readonly shutdown: () => Promise<void>; readonly dispose: () => void } {
  const target = options.process ?? process;
  const signals = options.signals ?? (["SIGINT", "SIGTERM", "SIGHUP"] as const);
  const forceAfterMs = Math.max(0, options.forceAfterMs ?? 30_000);
  const log = options.log ?? ((message: string) => console.error(message));
  let running: Promise<void> | undefined;

  const run = (): Promise<void> => {
    running ??= present(Effect.gen(function* () {
      const force = setTimeout(() => {
        log(`Shutdown did not finish within ${forceAfterMs} ms; exiting.`);
        target.exit(1);
      }, forceAfterMs);
      force.unref?.();
      let code = 0;
      yield* integration(() => shutdown()).pipe(
        Effect.catch((failure) => Effect.sync(() => {
          const error = unwrapFailure(failure);
          log(error instanceof Error ? (error.stack ?? error.message) : String(error));
          code = 1;
        })),
        Effect.ensuring(Effect.sync(() => clearTimeout(force))),
      );
      if (!options.keepAlive) target.exit(code);
      else if (code !== 0) process.exitCode = code;
    }));
    return running;
  };

  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const handler = () => {
      if (running) return;
      void run();
    };
    try {
      target.on(signal, handler);
      handlers.set(signal, handler);
    } catch {
      // Keep supported signals active while reporting the unavailable hook.
      console.warn(`Shutdown signal ${signal} is unavailable on this host.`);
    }
  }

  return {
    shutdown: run,
    dispose() {
      for (const [signal, handler] of handlers) target.off(signal, handler);
      handlers.clear();
    },
  };
}
