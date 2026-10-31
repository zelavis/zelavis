import { Clock, Cron, Effect, Fiber, Result } from "effect";
import { unrefSleep, type EntityStep } from "../../db/entities.js";
import type { DeliveredMessage } from "../../db/outbox.js";
import type { DatabaseRuntimeApi, RuntimeEntityHandler } from "../../db/runtime-api.js";
import { integration, present } from "../../core/runtime/effect-boundary.js";
import type { WorkloadDefinition, WorkloadsStore } from "./workloads-service.js";

/**
 * Durable Workloads: jobs, schedules and webhooks on durable entities and the outbox.
 *
 * - A **job** run is a message to the `job` entity named after the job workload, kept in its Tenant's mailbox until
 *   the job's code has handled it; its writes, outbox messages and reply commit with the message's processed mark.
 * - A **schedule** is a durable wake: the next fire time is already a pending message (`deliverAt`, keyed by the
 *   fire time) before it is due, so a restart loses nothing. The wake is armed, and the code runs, only where the
 *   database's writer is: this module is started with the entity runner and nowhere else.
 * - An **inbound webhook** is saved before it is answered, keyed by the provider's event id, so the provider's
 *   retries are recognised and its 2xx means the event is in the mailbox.
 * - An **outbound webhook** is delivery of outbox messages (`webhook.<name>`), at least once, each request carrying
 *   its message id as an `Idempotency-Key` for the receiver to deduplicate by.
 *
 * Every one of them is at least once to its code; their database effects land once.
 */

/** The entity types the three kinds of workload answer to; an `entity` workload may not take them. */
export const JOB_ENTITY = "job";
export const SCHEDULE_ENTITY = "schedule";
export const WEBHOOK_ENTITY = "webhook";
export const RESERVED_ENTITY_TYPES: ReadonlySet<string> = new Set([JOB_ENTITY, SCHEDULE_ENTITY, WEBHOOK_ENTITY]);

/** The outbox topic an outbound webhook named `name` delivers. */
export const outboundTopic = (name: string) => `webhook.${name}`;

export function createModuleDataUrl(workload: Pick<WorkloadDefinition, "id" | "updatedAt" | "code">) {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(workload.code)}#${encodeURIComponent(`${workload.id}:${workload.updatedAt}`)}`;
}

/** The first time after `after` a cron expression fires; `undefined` when it is not an expression. */
export const nextFire = (expression: string, after: number): number | undefined => {
  const parsed = Cron.parse(expression);
  return Result.isSuccess(parsed) ? Cron.next(parsed.success, after).getTime() : undefined;
};

export const isCronExpression = (expression: string) => Result.isSuccess(Cron.parse(expression));

const enc = new TextEncoder();
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const hmacKey = (secret: string, usage: "sign" | "verify") =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);

/** `sha256=<hex>` over a body: what an outbound request is signed with. */
export const signBody = (secret: string, body: string) =>
  Effect.gen(function* () {
    const key = yield* integration(() => hmacKey(secret, "sign"));
    return `sha256=${hex(yield* integration(() => crypto.subtle.sign("HMAC", key, enc.encode(body))))}`;
  });

/** Whether `header` is the signature of `body` under `secret`, compared in constant time by the platform. */
export const verifySignature = (secret: string, body: string, header: string | null) =>
  Effect.gen(function* () {
    const match = /^sha256=([0-9a-f]{64})$/i.exec(header?.trim() ?? "");
    if (match === null) return false;
    const signature = new Uint8Array(32);
    for (let index = 0; index < 32; index++) signature[index] = Number.parseInt(match[1]!.slice(index * 2, index * 2 + 2), 16);
    const key = yield* integration(() => hmacKey(secret, "verify"));
    return yield* integration(() => crypto.subtle.verify("HMAC", key, signature, enc.encode(body)));
  });

const HEADER_DENYLIST = new Set(["authorization", "cookie", "set-cookie", "proxy-authorization"]);
const HEADERS_KEPT = 64;
const HEADER_VALUE_LIMIT = 1024;

/** The request headers a saved webhook keeps: bounded, and never credentials or the signature itself. */
export const keptHeaders = (headers: Headers, signatureHeader: string): Record<string, string> => {
  const kept: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (Object.keys(kept).length >= HEADERS_KEPT) break;
    if (HEADER_DENYLIST.has(name) || name === signatureHeader) continue;
    kept[name] = value.slice(0, HEADER_VALUE_LIMIT);
  }
  return kept;
};

export const DEFAULT_SIGNATURE_HEADER = "x-hub-signature-256";

/** A provider's event id: the configured header, else the body's `id`. */
export const eventIdOf = (workload: Pick<WorkloadDefinition, "eventIdHeader">, headers: Headers, body: unknown): string | undefined => {
  const header = workload.eventIdHeader === undefined ? undefined : headers.get(workload.eventIdHeader)?.trim();
  if (header !== undefined && header !== "") return header;
  const id = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).id : undefined;
  return typeof id === "string" && id !== "" ? id : typeof id === "number" && Number.isFinite(id) ? String(id) : undefined;
};

/** What a durable workload's code receives and answers: an entity handler's contract. */
type Handler = RuntimeEntityHandler;

const loadHandler = (workload: WorkloadDefinition, cache: Map<string, Handler>): Handler => {
  const version = `${workload.id}:${workload.updatedAt}`;
  const known = cache.get(version);
  if (known !== undefined) return known;
  const handler: Handler = (message, context) => present(Effect.gen(function* () {
    const module = (yield* integration(() => import(createModuleDataUrl(workload)))) as { default?: unknown; handle?: unknown };
    const handle = module.default ?? module.handle;
    if (typeof handle !== "function") {
      throw new TypeError(`Workload "${workload.name}" must export a default function or a named handle function.`);
    }
    return (yield* integration(() => handle(message, context))) as EntityStep;
  }));
  cache.set(version, handler);
  return handler;
};

/** The pieces of the database a durable workload uses: `DatabaseRuntimeApi`. */
export type DurableServing = Pick<DatabaseRuntimeApi, "entities" | "forTenant">;

export interface DurableWorkloadOptions {
  /** How often workload definitions are read, so an added, changed or disabled one takes effect; two seconds. */
  readonly refreshMillis?: number;
  /** How often outbound webhooks look for new outbox messages; one second. */
  readonly deliveryMillis?: number;
  /** Fetch, for outbound webhooks; global `fetch` unless given. */
  readonly fetch?: typeof fetch;
}

const SCHEDULE_LEAD_WAKES = 100;
const DELIVERY_PAGE = 50;
const DELIVERY_ATTEMPTS = 8;
const DELIVERY_BACKOFF_BASE = 1000;
const DELIVERY_BACKOFF_CAP = 5 * 60_000;
const DELIVERY_TIMEOUT = 10_000;
/** Messages awaiting a retry; past this, no new ones are read until some are delivered. */
const DELIVERY_BACKLOG = 1000;

const now = () => new Date().toISOString();

/**
 * Serve durable Workloads until `stop`: the entity runner with the `entity`, `job`, `schedule` and `webhook`
 * workloads as handlers, the schedule wakes armed, and the outbound webhooks delivered. Run it where the database's
 * writer is, once; the wakes it arms and the commits it makes are conditional, so a second one cannot do harm, but
 * it would repeat work.
 *
 * Definitions are read every `refreshMillis`, so a workload added, changed or disabled takes effect without a
 * restart; a type with no enabled workload keeps its messages until one exists.
 */
export function serveDurableWorkloads(
  database: DurableServing,
  store: WorkloadsStore,
  options: DurableWorkloadOptions = {},
): { readonly stop: () => Promise<void> } {
  const refreshMillis = options.refreshMillis ?? 2000;
  const deliveryMillis = options.deliveryMillis ?? 1000;
  const send = options.fetch ?? fetch;
  const cache = new Map<string, Handler>();
  let entityHandlers = new Map<string, Handler>();
  let byKind: Record<"job" | "schedule" | "webhook", Map<string, WorkloadDefinition>> = { job: new Map(), schedule: new Map(), webhook: new Map() };
  let all: readonly WorkloadDefinition[] = [];

  /** Jobs, schedules and webhooks answer to one entity type each, and pick their code by the entity's id. */
  const dispatcher = (kind: "job" | "schedule" | "webhook"): Handler => (message, context) => {
    const workload = byKind[kind].get(message.id);
    if (workload === undefined) throw new TypeError(`No enabled ${kind} workload is named "${message.id}".`);
    return loadHandler(workload, cache)(message, context);
  };
  const jobs = dispatcher("job");
  const webhooks = dispatcher("webhook");
  const schedules: Handler = (message, context) => present(Effect.gen(function* () {
    const step = (yield* integration(() => dispatcher("schedule")(message, context))) ?? {};
    // The fire time the next wake counts from: a wake that waited out downtime still counts from when it ran, so
    // however many fires were missed, one runs.
    const fired = typeof message.payload.fireAt === "string" ? Date.parse(message.payload.fireAt) : 0;
    const kept = step.state === undefined ? context.state : step.state;
    return { ...step, state: { ...(kept ?? {}), lastFire: Math.max(Number.isFinite(fired) ? fired : 0, Date.now()) } } satisfies EntityStep;
  }));
  const handlerFor = (type: string): Handler | undefined =>
    type === JOB_ENTITY ? jobs : type === SCHEDULE_ENTITY ? schedules : type === WEBHOOK_ENTITY ? webhooks : entityHandlers.get(type);

  /** Armed schedules: the definition version and fire time a wake was last sent for. */
  const armed = new Map<string, { readonly version: string; readonly fireAt: number }>();

  const arm = (workload: WorkloadDefinition) => Effect.gen(function* () {
    const expression = workload.schedule;
    const tenant = workload.tenant;
    if (expression === undefined || tenant === undefined) return;
    const version = `${workload.id}:${workload.updatedAt}`;
    const known = armed.get(workload.id);
    const current = yield* Clock.currentTimeMillis;
    if (known !== undefined && known.version === version && known.fireAt > current) return;
    const entities = database.forTenant(tenant).entities;
    const state = yield* integration(() => entities.state({ type: SCHEDULE_ENTITY, id: workload.name }));
    const lastFire = typeof state?.state?.lastFire === "number" ? state.state.lastFire : current;
    const fireAt = nextFire(expression, lastFire);
    if (fireAt === undefined) return;
    const key = `${workload.name}@${new Date(fireAt).toISOString()}`;
    if (known === undefined || known.version !== version) {
      // First sight of this definition in this process: wakes armed for another expression or by a former
      // definition are withdrawn, so the schedule fires only on the times it has now.
      const pending = yield* integration(() => entities.mailbox({ type: SCHEDULE_ENTITY, id: workload.name, limit: SCHEDULE_LEAD_WAKES }));
      for (const message of pending.messages) {
        if (message.messageKey !== key) yield* integration(() => entities.cancel({ type: SCHEDULE_ENTITY, id: workload.name, messageKey: message.messageKey }));
      }
    }
    yield* integration(() => entities.send({
      type: SCHEDULE_ENTITY, id: workload.name, tag: "fire", payload: { schedule: workload.name, fireAt: new Date(fireAt).toISOString() },
      primaryKey: key, deliverAt: new Date(fireAt).toISOString(),
    }));
    armed.set(workload.id, { version, fireAt });
  });

  /** A schedule no longer enabled has no wake left to fire. */
  const disarm = (live: ReadonlySet<string>) => Effect.gen(function* () {
    for (const [id] of armed) {
      if (live.has(id)) continue;
      armed.delete(id);
      const workload = all.find((entry) => entry.id === id);
      if (workload?.tenant === undefined) continue;
      const entities = database.forTenant(workload.tenant).entities;
      const pending = yield* integration(() => entities.mailbox({ type: SCHEDULE_ENTITY, id: workload.name, limit: SCHEDULE_LEAD_WAKES }));
      for (const message of pending.messages) yield* integration(() => entities.cancel({ type: SCHEDULE_ENTITY, id: workload.name, messageKey: message.messageKey }));
    }
  });

  const refresh = Effect.gen(function* () {
    all = yield* integration(() => store.list());
    const enabled = all.filter((workload) => workload.enabled);
    entityHandlers = new Map(enabled.filter((workload) => workload.type === "entity").map((workload) => [workload.name, loadHandler(workload, cache)]));
    byKind = {
      job: new Map(enabled.filter((workload) => workload.type === "job").map((workload) => [workload.name, workload])),
      schedule: new Map(enabled.filter((workload) => workload.type === "schedule").map((workload) => [workload.name, workload])),
      webhook: new Map(enabled.filter((workload) => workload.type === "webhook").map((workload) => [workload.name, workload])),
    };
    // Versions no workload names any more are let go.
    const current = new Set(all.map((workload) => `${workload.id}:${workload.updatedAt}`));
    for (const version of cache.keys()) if (!current.has(version)) cache.delete(version);
    // Wakes are armed per schedule, and one that cannot be reached does not stop the others.
    const schedulesNow = enabled.filter((workload) => workload.type === "schedule");
    yield* Effect.forEach(schedulesNow, (workload) => arm(workload).pipe(
      Effect.catchCause((cause) => Effect.logWarning(`The schedule "${workload.name}" could not be armed; the next refresh tries again`, cause)),
    ), { concurrency: 4, discard: true });
    yield* disarm(new Set(schedulesNow.map((workload) => workload.id)));
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("Workloads could not be read; the runner keeps the handlers it had", cause)));

  // ---- outbound webhooks ----

  /** Per outbound webhook: where in the outbox it has read to, and what it owes a retry. */
  const outbound = new Map<string, { cursor?: string; readonly retry: Map<string, { attempts: number; at: number; message: DeliveredMessage }> }>();

  const deliver = (workload: WorkloadDefinition, message: DeliveredMessage) => Effect.gen(function* () {
    const url = workload.url!;
    const body = JSON.stringify({ id: message.id, topic: message.topic, payload: message.payload, emittedAt: message.emittedAt });
    const headers: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
      "idempotency-key": message.id,
      "user-agent": "Zelavis-Webhooks",
    };
    if (workload.secret !== undefined && workload.secret !== "") headers["x-zelavis-signature"] = yield* signBody(workload.secret, body);
    const response = yield* integration((signal) => send(url, {
      method: "POST", headers, body, redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(DELIVERY_TIMEOUT)]),
    }), { interruptible: true });
    yield* integration(() => response.body?.cancel());
    return response.status;
  });

  const logDelivery = (workload: WorkloadDefinition, message: DeliveredMessage, status: "completed" | "failed", output: string, responseStatus?: number) =>
    integration(() => store.appendLog({
      id: `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      workloadId: workload.id, projectId: workload.projectId, status, output: `${message.id}: ${output}`, createdAt: now(),
      ...(responseStatus === undefined ? {} : { responseStatus }),
    })).pipe(Effect.catchCause(() => Effect.void));

  const deliverFor = (workload: WorkloadDefinition) => Effect.gen(function* () {
    const tenant = workload.tenant;
    if (tenant === undefined || workload.url === undefined) return;
    const outbox = database.forTenant(tenant).outbox;
    const topic = outboundTopic(workload.name);
    let state = outbound.get(workload.id);
    if (state === undefined) { state = { retry: new Map() }; outbound.set(workload.id, state); }
    const queue = state;
    const attempt = (message: DeliveredMessage, attempts: number) => Effect.gen(function* () {
      const result = yield* Effect.exit(deliver(workload, message));
      if (result._tag === "Success" && result.value >= 200 && result.value < 300) {
        yield* integration(() => outbox.remove({ ids: [message.id] }));
        queue.retry.delete(message.id);
        yield* logDelivery(workload, message, "completed", `delivered (${result.value})`, result.value);
        return;
      }
      const reason = result._tag === "Success" ? `the receiver answered ${result.value}` : "the request failed";
      const next = attempts + 1;
      yield* logDelivery(workload, message, "failed", `attempt ${next} of ${DELIVERY_ATTEMPTS}: ${reason}`, result._tag === "Success" ? result.value : undefined);
      // Out of attempts the message stays in the outbox, untouched, and is tried again when the runner next starts.
      queue.retry.set(message.id, { attempts: next, message, at: next >= DELIVERY_ATTEMPTS ? Number.POSITIVE_INFINITY : (yield* Clock.currentTimeMillis) + Math.min(DELIVERY_BACKOFF_BASE * 2 ** (next - 1), DELIVERY_BACKOFF_CAP) });
    });
    const at = yield* Clock.currentTimeMillis;
    for (const [, owed] of queue.retry) if (owed.at <= at) yield* attempt(owed.message, owed.attempts);
    if (queue.retry.size >= DELIVERY_BACKLOG) return;
    for (let pages = 0; pages < 4; pages++) {
      const page = yield* integration(() => outbox.read({ topic, limit: DELIVERY_PAGE, ...(queue.cursor === undefined ? {} : { after: queue.cursor as never }) }));
      for (const message of page.messages) if (!queue.retry.has(message.id)) yield* attempt(message, 0);
      if (page.cursor !== undefined) queue.cursor = page.cursor as string;
      if (!page.more) break;
    }
  });

  const deliverAll = Effect.gen(function* () {
    const targets = [...byKind.webhook.values()].filter((workload) => workload.url !== undefined && workload.tenant !== undefined);
    const live = new Set(targets.map((workload) => workload.id));
    for (const id of outbound.keys()) if (!live.has(id)) outbound.delete(id);
    yield* Effect.forEach(targets, (workload) => deliverFor(workload).pipe(
      Effect.catchCause((cause) => Effect.logWarning(`Outbound webhook "${workload.name}" could not be delivered; the next pass tries again`, cause)),
    ), { concurrency: 4, discard: true });
  });

  const refreshing = Effect.runFork(Effect.andThen(refresh, Effect.forever(Effect.andThen(unrefSleep(refreshMillis), refresh))));
  const delivering = Effect.runFork(Effect.forever(Effect.andThen(unrefSleep(deliveryMillis), deliverAll)));
  const serving = database.entities.serve(handlerFor);
  return {
    stop: () => present(Effect.gen(function* () {
      yield* Fiber.interrupt(refreshing);
      yield* Fiber.interrupt(delivering);
      yield* integration(() => serving.stop());
    })),
  };
}
