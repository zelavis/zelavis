// Runs an Alchemy stack headless against the fake Hetzner API, through the
// package's own runner (no telemetry, no ambient home directory, credentials as
// in-memory configuration).
import diagnosticsChannel from "node:diagnostics_channel";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as State from "alchemy/State";
import { capacityIdentity, hetznerCapacityStack, makeAlchemyRunner } from "../dist/index.js";

export const STACK = "zelavis-capacity";
export const STAGE = "test";

/**
 * An in-memory Alchemy state store that can be made to fail, and wiped, to
 * stand in for a crash between the cloud call and the state write.
 */
export async function makeState() {
  const store = {};
  const fault = { failNextCreatedWrite: 0 };
  const base = await Effect.runPromise(State.InMemoryService(store, {}));
  const service = {
    ...base,
    set: (request) => {
      if (fault.failNextCreatedWrite > 0 && request.value?.status === "created") {
        fault.failNextCreatedWrite--;
        return Effect.fail(new State.StateStoreError({ message: "injected state write failure" }));
      }
      return base.set(request);
    },
  };
  return {
    stack: STACK,
    stage: STAGE,
    layer: Layer.succeed(State.State, Effect.succeed(service)),
    fault,
    row: (fqn) => store[STACK]?.[STAGE]?.[fqn],
    stored: () => Object.keys(store[STACK]?.[STAGE] ?? {}),
    lose: () => {
      delete store[STACK];
    },
  };
}

/** A capacity machine, declared by the production stack definition. */
export function capacityStack({ requestId, platformId = "platform-1", state, deterministic = true }) {
  const identity = capacityIdentity({ requestId, platformId });
  return hetznerCapacityStack({
    identity: deterministic ? identity : { labels: identity.labels },
    serverType: "cpx11",
    image: "ubuntu-24.04",
    location: "nbg1",
    state,
  });
}

export function makeRunner({ fake, state, workDir = mkdtempSync(join(tmpdir(), "zelavis-cloud-")) }) {
  const runner = makeAlchemyRunner({
    config: { HCLOUD_TOKEN: fake.token, HCLOUD_ENDPOINT: fake.url },
    workDir,
  });
  const run = (effect) => Effect.runPromise(effect);
  return {
    workDir,
    deploy: (stack) => run(runner.deploy({ stack, stage: STAGE, state })),
    destroy: (stack) => run(runner.destroy({ stack, stage: STAGE, state })),
  };
}

/**
 * The hosts this process makes HTTP requests to, observed at the Node level so
 * it holds whichever HTTP client is used. Stops observing when `t` ends.
 */
export function observeOrigins(t) {
  const origins = new Set();
  const onUndici = ({ request }) => origins.add(new URL(request.origin).host);
  const onHttp = ({ request }) => origins.add(request.getHeader("host"));
  diagnosticsChannel.subscribe("undici:request:create", onUndici);
  diagnosticsChannel.subscribe("http.client.request.start", onHttp);
  t.after(() => {
    diagnosticsChannel.unsubscribe("undici:request:create", onUndici);
    diagnosticsChannel.unsubscribe("http.client.request.start", onHttp);
  });
  return origins;
}
