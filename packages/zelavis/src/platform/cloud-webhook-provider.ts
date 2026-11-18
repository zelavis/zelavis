import { Effect, Semaphore } from "effect";
import { capacityNodeNameFromDigest, type CapacityProvider, type ZelavisCapacityNode, type ZelavisCapacityProvisionInput } from "../core/provider/index.js";
import { evaluate, integration } from "../core/runtime/effect-boundary.js";
import type { ZelavisSystemStore, ZelavisSystemStoreRecord, ZelavisSystemStoreValue } from "../system-store.js";
import { CloudCapacityError } from "./cloud-capacity.js";
import type { CloudCapacityPolicy } from "./cloud-capacity.js";

export const CLOUD_WEBHOOK_NODES_NAMESPACE = "fabric.cloud-webhook-nodes.v1";
const MAX_BODY = 256 * 1024;
const MAX_NODES = 100;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const failed = (message: string) => new CloudCapacityError({ code: "provider-failed", message });
const fields = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");

/** Signed machine requests. Only the locally recorded set confers deletion authority; remote inventory never does. */
export const createWebhookCapacityProvider = (options: {
  readonly endpoint: string;
  readonly secret: string;
  readonly platformId: string;
  readonly store: ZelavisSystemStore;
  readonly policy: CloudCapacityPolicy;
  readonly firstBoot: (nodeId: string) => Promise<string>;
  readonly isEnrolled: (nodeId: string) => Promise<boolean>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly authority?: () => Promise<boolean>;
  /** Shared across the connection's short-lived provider instances. */
  readonly calls?: Semaphore.Semaphore;
  readonly mutations?: Semaphore.Semaphore;
}): CapacityProvider => {
  const calls = options.calls ?? Semaphore.makeUnsafe(2);
  const mutations = options.mutations ?? Semaphore.makeUnsafe(1);
  const { store } = options;
  const current = Effect.fn("webhook.authority")(function* () {
    if (options.authority && !(yield* integration(() => options.authority!()))) return yield* failed("Cloud authority was superseded.");
  });
  const own = (record: ZelavisSystemStoreRecord) => {
    const value = fields(record.value);
    if (value.schemaVersion !== 1 || value.platformId !== options.platformId || value.nodeId !== record.key || !ID.test(record.key) || typeof value.requestId !== "string" || !ID.test(value.requestId)) throw failed("The recorded webhook machine is malformed.");
    return record;
  };
  const records = Effect.fn("webhook.records")(function* () {
    const page = yield* integration(() => store.page(CLOUD_WEBHOOK_NODES_NAMESPACE, { limit: MAX_NODES + 1 }));
    if (page.next || page.records.length > MAX_NODES) return yield* failed("The recorded webhook machine limit was exceeded.");
    return yield* evaluate(() => page.records.map(own));
  });
  const recorded = Effect.fn("webhook.recorded")(function* (id: string) {
    if (!ID.test(id)) return yield* failed("The webhook machine id is invalid.");
    const record = yield* integration(() => store.get(CLOUD_WEBHOOK_NODES_NAMESPACE, id));
    return record === undefined ? undefined : yield* evaluate(() => own(record));
  });
  const request = Effect.fn("webhook.request")(function* (payload: Record<string, unknown>) {
    return yield* calls.withPermit(Effect.gen(function* () {
      yield* current();
      const url = yield* evaluate(() => new URL(options.endpoint));
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.href.length > 2048) return yield* failed("The webhook endpoint must be HTTPS without credentials, query or fragment.");
      const raw = JSON.stringify({ version: 1, ...payload, platformId: options.platformId });
      const timestamp = Math.floor((options.now ?? Date.now)() / 1000);
      const key = yield* integration(() => crypto.subtle.importKey("raw", new TextEncoder().encode(options.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));
      const signature = hex(yield* integration(() => crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${raw}`))));
      const response = yield* Effect.tryPromise({
        try: signal => (options.fetch ?? fetch)(url.href, { method: "POST", headers: { "content-type": "application/json", "zelavis-signature": `t=${timestamp},v1=${signature}` }, body: raw, redirect: "manual", signal }),
        catch: () => failed("The webhook request could not be completed."),
      });
      const status = response.status;
      return yield* Effect.gen(function* () {
        if (!response.ok || status >= 300) return yield* failed(`The webhook returned HTTP ${status}.`);
        if (!response.body) return yield* failed(`The webhook returned an empty body (HTTP ${status}).`);
        const reader = response.body.getReader();
        const body = yield* Effect.gen(function* () {
          let size = 0;
          const chunks: Uint8Array[] = [];
          for (;;) {
            const chunk = yield* Effect.tryPromise({ try: () => reader.read(), catch: () => failed(`The webhook body was interrupted (HTTP ${status}).`) });
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > MAX_BODY) return yield* failed(`The webhook body exceeds 256 KiB (HTTP ${status}).`);
            chunks.push(chunk.value);
          }
          const bytes = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          return yield* evaluate(() => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown).pipe(Effect.mapError(() => failed(`The webhook body is malformed (HTTP ${status}).`)));
        }).pipe(Effect.ensuring(integration(() => reader.cancel()).pipe(Effect.catch(() => Effect.logWarning("cloud.webhook.response-close-failed")))));
        if (typeof body !== "object" || body === null || Array.isArray(body)) return yield* failed(`The webhook body is malformed (HTTP ${status}).`);
        return { body: fields(body), status };
      }).pipe(Effect.ensuring(integration(() => response.body && !response.body.locked ? response.body.cancel() : undefined).pipe(Effect.catch(() => Effect.logWarning("cloud.webhook.response-close-failed")))));
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError(error => error instanceof CloudCapacityError ? error : failed("The webhook request failed or timed out.")),
    ));
  });
  const node = Effect.fn("webhook.node")(function* (value: unknown, status: number): Effect.fn.Return<ZelavisCapacityNode, CloudCapacityError> {
    const parsed = fields(value);
    if (typeof parsed.id !== "string" || !ID.test(parsed.id) || !["provisioning", "ready", "releasing", "failed"].includes(String(parsed.state)) ||
        (parsed.region !== undefined && (typeof parsed.region !== "string" || parsed.region.length > 128))) return yield* failed(`The webhook returned a malformed node (HTTP ${status}).`);
    const state = parsed.state as ZelavisCapacityNode["state"];
    const ready = state === "ready" ? yield* integration(() => options.isEnrolled(parsed.id as string)).pipe(Effect.mapError(() => failed("The machine enrollment could not be checked."))) : false;
    return { id: parsed.id, provider: "webhook", state: state === "ready" && !ready ? "provisioning" : state, ...(parsed.region === undefined ? {} : { region: parsed.region as string }) };
  });
  const forget = (record: ZelavisSystemStoreRecord) => integration(() => store.compareAndDelete(CLOUD_WEBHOOK_NODES_NAMESPACE, record.key, record.updatedAt, record.value));
  const get = Effect.fn("webhook.get")(function* (id: string) {
    const record = yield* recorded(id);
    if (!record) return undefined;
    const { body: answer, status } = yield* request({ action: "get", nodeId: id });
    if (answer.node === null) { yield* forget(record); return undefined; }
    const result = yield* node(answer.node, status);
    if (result.id !== id) return yield* failed(`The webhook answered for another machine (HTTP ${status}).`);
    return result;
  });
  const list = Effect.fn("webhook.list")(function* () {
    const known = yield* records();
    const { body: answer, status } = yield* request({ action: "list" });
    if (!Array.isArray(answer.nodes) || answer.nodes.length > MAX_NODES) return yield* failed(`The webhook returned a malformed node list (HTTP ${status}).`);
    const nodes = yield* Effect.forEach(answer.nodes, value => node(value, status), { concurrency: 2 });
    if (new Set(nodes.map(n => n.id)).size !== nodes.length) return yield* failed(`The webhook returned duplicate machines (HTTP ${status}).`);
    const byId = new Map(nodes.map(n => [n.id, n]));
    const found = yield* Effect.forEach(known, record => byId.has(record.key) ? Effect.succeed(byId.get(record.key)) : get(record.key), { concurrency: 2 });
    return found.filter((entry): entry is ZelavisCapacityNode => entry !== undefined);
  });
  const provision = Effect.fn("webhook.provision")(function* (input: ZelavisCapacityProvisionInput) {
    yield* current();
    if (!ID.test(input.requestId) || input.platformId !== options.platformId) return yield* failed("The capacity request identity is invalid.");
    if (input.resources && Object.entries(input.resources).some(([key, v]) => typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > Number.MAX_SAFE_INTEGER || (key !== "cpuCores" && !Number.isSafeInteger(v)))) return yield* failed("The requested resources must be positive safe integers.");
    const region = input.region ?? options.policy.location;
    if (region !== options.policy.location && !options.policy.allowedLocations?.includes(region)) return yield* failed("The requested location is not allowed by policy.");
    const machineClass = [...options.policy.machineClasses].filter(c => c.cpuCores >= (input.resources?.cpuCores ?? 0) && c.memoryBytes >= (input.resources?.memoryBytes ?? 0) && c.diskBytes >= (input.resources?.diskBytes ?? 0)).sort((a, b) => a.cpuCores - b.cpuCores || a.memoryBytes - b.memoryBytes || a.diskBytes - b.diskBytes)[0];
    if (!machineClass) return yield* failed("No approved machine class satisfies the request.");
    const digest = hex(yield* integration(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.requestId))));
    const nodeId = capacityNodeNameFromDigest(input.requestId, digest);
    const existing = yield* recorded(nodeId);
    const value = { schemaVersion: 1, platformId: options.platformId, requestId: input.requestId, nodeId, region, machineClass, image: options.policy.image, location: options.policy.location };
    if (existing && JSON.stringify(existing.value) !== JSON.stringify(value)) return yield* failed("The capacity request has changed; use a new request id.");
    if (!existing) {
      const known = yield* records();
      if (known.length >= options.policy.maxNodes) return yield* failed("The machine policy's maximum nodes has been reached.");
      const written = yield* integration(() => store.setIfAbsent(CLOUD_WEBHOOK_NODES_NAMESPACE, nodeId, value as unknown as ZelavisSystemStoreValue));
      if (!written.created && JSON.stringify(written.record.value) !== JSON.stringify(value)) return yield* failed("The capacity request has changed.");
    }
    const firstBoot = yield* integration(() => options.firstBoot(nodeId));
    const { body: answer, status } = yield* request({ action: "provision", requestId: input.requestId, nodeId, region, machineClass, image: options.policy.image, location: options.policy.location, firstBoot });
    if (answer.node === null) return yield* failed(`The webhook returned no provisioned machine (HTTP ${status}).`);
    const result = yield* node(answer.node, status);
    if (result.id !== nodeId) return yield* failed(`The webhook answered for another machine (HTTP ${status}).`);
    return result;
  });
  const release = Effect.fn("webhook.release")(function* (id: string) {
    yield* current();
    const record = yield* recorded(id);
    if (!record) return yield* failed("The machine was not provisioned by this Platform.");
    const { body: answer, status } = yield* request({ action: "release", nodeId: id });
    if (Object.keys(answer).length !== 0) return yield* failed(`The webhook returned a malformed release receipt (HTTP ${status}).`);
    yield* forget(record);
  });
  const run = <A, E>(program: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(program.pipe(Effect.mapError(error => error instanceof CloudCapacityError ? error : failed("The webhook provider failed."))));
  return {
    list: () => run(mutations.withPermit(list())),
    get: id => run(mutations.withPermit(get(id))),
    provision: input => run(mutations.withPermit(provision(input))),
    release: id => run(mutations.withPermit(release(id))),
  };
};
