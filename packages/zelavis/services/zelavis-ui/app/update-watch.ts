import { Effect, Fiber } from "effect";
import { ApiError, object, request } from "./api.ts";
import { updatePollDelay, type UpdateStatus } from "./updates.ts";

/**
 * One shared view of the installation's update state for the whole dashboard.
 *
 * The banner in the shell and the card in Settings read the same snapshot, so there is a single poller and a click
 * in one shows in the other. It polls slowly when idle and quickly while an update runs. The Platform restarts
 * during an update, so a refused connection while one is in progress means "reconnecting", not "broken". When
 * the version it reports is not the one this page was loaded from, the page reloads so the new dashboard is the one shown.
 */
export interface UpdateSnapshot {
  status: UpdateStatus | undefined;
  unavailable: boolean;
  reconnecting: boolean;
  error: string | undefined;
  busy: boolean;
}

let snapshot: UpdateSnapshot = { status: undefined, unavailable: false, reconnecting: false, error: undefined, busy: false };
let loadedFrom: string | undefined;
let api: string | undefined;
let fiber: Fiber.Fiber<unknown, never> | undefined;
const listeners = new Set<() => void>();

const publish = (next: Partial<UpdateSnapshot>) => { snapshot = { ...snapshot, ...next }; for (const listener of [...listeners]) listener(); };
const working = () => snapshot.status?.state === "requested" || snapshot.status?.state === "running";

const decode = (value: unknown): UpdateStatus => value as UpdateStatus;
const receive = (status: UpdateStatus) => {
  loadedFrom ??= status.current;
  publish({ status, reconnecting: false });
  if (loadedFrom !== status.current) window.location.reload();
};

const read = Effect.fn("ui.updateRead")(function*() {
  if (!api) return;
  const outcome = yield* request(`${api}/runtime/updates`).pipe(Effect.result);
  if (outcome._tag === "Success") { receive(decode(object(outcome.success))); return; }
  if (outcome.failure.status !== undefined && [401, 403, 404].includes(outcome.failure.status)) { publish({ unavailable: true }); return; }
  // While an update runs the Platform restarts, so a refused connection is expected.
  if (working()) publish({ reconnecting: true });
});

const poll = () => Effect.runFork(Effect.forever(Effect.gen(function*() {
  yield* read();
  if (snapshot.unavailable) return yield* Effect.never;
  yield* Effect.sleep(updatePollDelay(snapshot.status, snapshot.reconnecting));
})));
const stop = () => { if (fiber) Effect.runFork(Fiber.interrupt(fiber)); fiber = undefined; };

/** Starts the poller once for this page; the returned function stops it. */
export function startUpdateWatch(apiBase: string) {
  api = apiBase;
  // Signing in after a refusal makes the status readable, so a stopped poller starts again.
  if (snapshot.unavailable) { publish({ unavailable: false }); stop(); }
  fiber ??= poll();
  return stop;
}

/** Polls again now, so a click is followed at the fast pace without waiting out the idle delay. */
function wake() { if (!fiber) return; stop(); fiber = poll(); }

export const getUpdateSnapshot = () => snapshot;
export function subscribeUpdates(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

const act = (path: string) => {
  if (!api) return;
  publish({ busy: true, error: undefined });
  Effect.runFork(request(`${api}/runtime/updates/${path}`, "POST").pipe(
    Effect.tap(value => Effect.sync(() => receive(decode(object(value))))),
    Effect.catch((error: ApiError) => Effect.sync(() => publish({ error: error.message }))),
    Effect.ensuring(Effect.sync(() => { publish({ busy: false }); wake(); }))));
};
export const checkForUpdate = () => act("check");
export const applyUpdate = () => act("apply");
