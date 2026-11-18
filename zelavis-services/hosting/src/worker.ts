import { Effect, Fiber } from "effect";
import type { ZelavisServerPlugin } from "zelavis/core";

export function hostingWorker(
  name: string, intervalMs: number, pass: () => Effect.Effect<void, { readonly code: string }>,
): ZelavisServerPlugin {
  return ({ hooks }) => {
    let fiber: Fiber.Fiber<void, never> | undefined;
    hooks.hook("start", () => {
      fiber = Effect.runFork(Effect.forever(Effect.sleep(intervalMs).pipe(
        Effect.andThen(pass),
        Effect.catch(error => Effect.logWarning(`Hosting ${name} reconciliation pass failed`, { code: error.code })),
      )));
    });
    return () => fiber ? Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.asVoid)) : undefined;
  };
}
