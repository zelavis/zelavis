/** Platform registrar state. Secrets are sealed; purchase intents are durable and never automatically submitted twice. */
import { Data, Effect, Fiber, Option, Schema, Semaphore } from "effect";
import { evaluate, integration, present } from "../core/runtime/effect-boundary.js";
import type { ZelavisSystemStore, ZelavisSystemStoreRecord, ZelavisSystemStoreValue } from "../system-store.js";
import { decryptSecret, encryptSecret } from "./acme-crypto.js";
import type { RegistrarClient, RegistrarListing } from "./registrar-provider.js";

export const REGISTRAR_CONNECTION = "registrar.connection";
export const REGISTRAR_CONTACTS = "registrar.contacts";
export const REGISTRAR_ORDERS = "registrar.orders";
export const REGISTRAR_KEYS = "registrar.order-keys";
export class RegistrarError extends Data.TaggedError("RegistrarError")<{
  readonly code: "invalid_registrar_request" | "registrar_order_not_found" | "price_changed" | "domain_unavailable" | "registrar_contact_missing" | "registrar_failed" | "registrar_unavailable" | "registrar_busy";
  readonly message: string; readonly price?: RegistrarPrice; readonly definite?: boolean;
}> {}
export const REGISTRAR_STATUSES: Readonly<Record<RegistrarError["code"], number>> = { invalid_registrar_request: 400, registrar_order_not_found: 404, price_changed: 409, domain_unavailable: 409, registrar_contact_missing: 409, registrar_failed: 502, registrar_unavailable: 503, registrar_busy: 429 };
const failure = (code: RegistrarError["code"], message: string) => new RegistrarError({ code, message });
const strict = { onExcessProperty: "error" } as const;
const text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max), Schema.isPattern(/^[^\x00-\x1f\x7f]+$/u));
export const RegistrarDomainSchema = text(70).check(Schema.isPattern(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u));
const Years = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }));
export const RegistrarPriceSchema = Schema.Struct({ amount: Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,4})?$/u)), currency: Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/u)), years: Years });
export type RegistrarPrice = typeof RegistrarPriceSchema.Type;
export const RegistrarContactSchema = Schema.Struct({ firstName: text(255), lastName: text(255), organization: Schema.optionalKey(text(255)), address1: text(255), address2: Schema.optionalKey(text(255)), city: text(50), stateProvince: text(50), postalCode: text(50), country: Schema.String.check(Schema.isPattern(/^[A-Z]{2}$/u)), phone: Schema.String.check(Schema.isPattern(/^\+[0-9]{1,3}\.[0-9]{4,14}$/u)), email: text(255).check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u)) });
const Secret = Schema.Struct({ ciphertext: Schema.String, iv: Schema.String, tag: Schema.String, algorithm: Schema.Literal("AES-256-GCM") });
const Timestamp = text(40).check(Schema.makeFilter(value => Number.isFinite(Date.parse(value))));
const Connection = Schema.Struct({ schemaVersion: Schema.Literal(1), provider: text(32), sandbox: Schema.Boolean, credentials: Secret, revision: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)), updatedAt: Timestamp });
const Contact = Schema.Struct({ schemaVersion: Schema.Literal(1), encryptedContact: Secret, revision: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)), updatedAt: Timestamp });
export const ConnectRegistrarSchema = Schema.Struct({ provider: text(32), sandbox: Schema.Boolean, credentials: Schema.Record(text(32), text(1024)), expectedRevision: Schema.optionalKey(Schema.Natural) });
export const SetRegistrarContactSchema = Schema.Struct({ contact: RegistrarContactSchema, expectedRevision: Schema.optionalKey(Schema.Natural) });
export const RegistrarAvailabilitySchema = Schema.Struct({ domains: Schema.Array(RegistrarDomainSchema).check(Schema.isMinLength(1), Schema.isMaxLength(20)) });
export const RegistrarQuoteSchema = Schema.Struct({ domain: RegistrarDomainSchema, kind: Schema.Literals(["register", "renew", "transfer"]), years: Years });
export const RegistrarNameserversSchema = Schema.Struct({ nameservers: Schema.Array(RegistrarDomainSchema).check(Schema.isMinLength(2), Schema.isMaxLength(12)) });
export const decodeConnectRegistrar = Schema.decodeUnknownSync(ConnectRegistrarSchema, strict);
export const decodeSetRegistrarContact = Schema.decodeUnknownSync(SetRegistrarContactSchema, strict);
export type ConnectRegistrarInput = typeof ConnectRegistrarSchema.Type;
export type SetRegistrarContactInput = typeof SetRegistrarContactSchema.Type;
const decodeConnection = Schema.decodeUnknownSync(Connection, strict);
const decodeContact = Schema.decodeUnknownSync(Contact, strict);
const credentialsDecoder = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String));
const contactDecoder = Schema.decodeUnknownSync(RegistrarContactSchema, strict);
const stored = (value: unknown) => value as ZelavisSystemStoreValue;
const invalid = () => failure("invalid_registrar_request", "Supply valid registrar fields.");
const validated = <A>(decode: (value: unknown) => A, input: unknown) => evaluate(() => decode(input)).pipe(Effect.mapError(invalid));
const providerValue = <A>(decode: (value: unknown) => A, input: unknown) => evaluate(() => decode(input)).pipe(Effect.mapError(() => failure("registrar_failed", "The registrar returned an unexpected response.")));

const IdempotencyKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{8,128}$/u));
export const RegistrarOrderInputSchema = Schema.Struct({
  kind: Schema.Literals(["register", "transfer", "renew"]), domain: RegistrarDomainSchema, years: Years,
  authCode: Schema.optionalKey(text(256)), confirm: RegistrarPriceSchema, idempotencyKey: IdempotencyKey,
}).check(Schema.makeFilter(input => input.confirm.years === input.years && (input.kind === "transfer" ? input.authCode !== undefined : input.authCode === undefined)));
export type RegistrarOrderInput = typeof RegistrarOrderInputSchema.Type;
const Order = Schema.Struct({
  schemaVersion: Schema.Literal(1), id: text(80), kind: Schema.Literals(["register", "transfer", "renew"]), domain: RegistrarDomainSchema, years: Years,
  state: Schema.Literals(["requested", "submitting", "completed", "failed", "unknown", "pending_transfer"]),
  price: RegistrarPriceSchema, idempotencyKey: IdempotencyKey, principalId: text(256), createdAt: Timestamp, updatedAt: Timestamp,
  provider: text(32), sandbox: Schema.Boolean, connectionRevision: Schema.Natural,
  registrarOrderId: Schema.optionalKey(text(128)), transferId: Schema.optionalKey(text(128)), detail: Schema.optionalKey(text(200)),
  previousExpiresAt: Schema.optionalKey(Timestamp), attempts: Schema.Natural, nextReconcileAt: Timestamp,
});
const decodeOrder = Schema.decodeUnknownSync(Order, strict);
export type RegistrarOrder = Omit<typeof Order.Type, "schemaVersion" | "connectionRevision" | "previousExpiresAt" | "attempts" | "nextReconcileAt">;
const orderView = (row: typeof Order.Type): RegistrarOrder => {
  const { schemaVersion: _schema, connectionRevision: _revision, previousExpiresAt: _expiry, attempts: _attempts, nextReconcileAt: _next, ...view } = row;
  return view;
};
const activeNamespace = "registrar.active-orders";
const terminal = (row: typeof Order.Type) => row.state === "completed" || row.state === "failed";
const DomainResult = Schema.Struct({ owned: Schema.Boolean, expiresAt: Schema.optionalKey(Timestamp), nameservers: Schema.optionalKey(Schema.Array(RegistrarDomainSchema)) });
/** Idle reconciliation must not hold an embedded process open. The runtime still cancels the fiber on close. */
const idle = (millis: number) => Effect.callback<void>(resume => {
  const timer = setTimeout(() => resume(Effect.void), millis);
  (timer as { unref?: () => void }).unref?.();
  return Effect.sync(() => clearTimeout(timer));
});
const decimalUnits = (amount: string) => { const [whole, fraction = ""] = amount.split("."); return BigInt(whole!) * BigInt(10_000) + BigInt(fraction.padEnd(4, "0")); };
const samePrice = (a: RegistrarPrice, b: RegistrarPrice) => decimalUnits(a.amount) === decimalUnits(b.amount) && a.currency === b.currency && a.years === b.years;

export function createRegistrarController(options: {
  readonly store: ZelavisSystemStore; readonly masterSecret: string; readonly providers: readonly RegistrarListing[];
  readonly fetch?: typeof fetch; readonly now?: () => Date; readonly readTimeoutMs?: number; readonly submitTimeoutMs?: number; readonly reconcileIntervalMs?: number;
}) {
  const { store } = options; const now = options.now ?? (() => new Date());
  const providers = new Map(options.providers.map(row => [row.definition.name, row]));
  const permit = Semaphore.makeUnsafe(1);
  const secretKey = `${options.masterSecret}\u0000registrar.connection`;
  const contactKey = `${options.masterSecret}\u0000registrar.contact`;
  const shutdown = new AbortController();
  const loadConnection = Effect.fn("Registrar.connection")(function* () {
    const record = yield* integration(() => store.get(REGISTRAR_CONNECTION, "current"));
    return record ? { record, value: yield* evaluate(() => decodeConnection(record.value)) } : undefined;
  });
  const loadContact = Effect.fn("Registrar.contact")(function* () {
    const record = yield* integration(() => store.get(REGISTRAR_CONTACTS, "default"));
    if (!record) return undefined;
    const value = yield* evaluate(() => decodeContact(record.value));
    const contact = yield* evaluate(() => { const parsed: unknown = JSON.parse(decryptSecret(value.encryptedContact, contactKey)); return contactDecoder(parsed); });
    return { record, value, contact };
  });
  const configured = Effect.fn("Registrar.configured")(function* () {
    if (shutdown.signal.aborted) return yield* failure("registrar_unavailable", "The registrar is stopping.");
    const connection = yield* loadConnection();
    const provider = connection && providers.get(connection.value.provider);
    if (!connection || !provider) return yield* failure("registrar_unavailable", "Connect an installed registrar first.");
    const credentials = yield* evaluate(() => { const parsed: unknown = JSON.parse(decryptSecret(connection.value.credentials, secretKey)); return credentialsDecoder(parsed); });
    return { ...connection, definition: provider.definition, credentials };
  });
  type Configured = Effect.Success<ReturnType<typeof configured>>;
  const call = <A>(connection: Configured, operation: string, use: (client: RegistrarClient) => Promise<A>, purchase = false) => Effect.gen(function* () {
    const result = yield* Effect.result(Effect.tryPromise({
      try: signal => {
        const client = connection.definition.createClient(connection.credentials, { fetch: options.fetch ?? globalThis.fetch, signal: AbortSignal.any([signal, shutdown.signal]), sandbox: connection.value.sandbox });
        return use(client);
      },
      catch: cause => new RegistrarError({ code: "registrar_failed", message: "The registrar call failed. Check the registrar account for details.", definite: typeof cause === "object" && cause !== null && "definite" in cause && cause.definite === true }),
    }).pipe(Effect.timeout(purchase ? options.submitTimeoutMs ?? 60_000 : options.readTimeoutMs ?? 15_000), Effect.mapError(error => error instanceof RegistrarError ? error : failure("registrar_failed", "The registrar call timed out; its outcome may be unknown."))));
    yield* Effect.logInfo("registrar.call", { provider: connection.value.provider, operation, outcome: result._tag === "Success" ? "ok" : "failed" });
    return yield* Effect.fromResult(result);
  });
  const save = Effect.fn("Registrar.save")(function* (namespace: string, key: string, record: ZelavisSystemStoreRecord | undefined, value: unknown) {
    const result = record ? yield* integration(() => store.compareAndSet(namespace, key, record.updatedAt, stored(value), record.value)) : (yield* integration(() => store.setIfAbsent(namespace, key, stored(value)))).created;
    if (!result) return yield* failure("invalid_registrar_request", "The registrar setting changed. Refresh and retry.");
  });
  const exclusive = <A, E>(program: Effect.Effect<A, E>) => permit.withPermit(program);
  const readOrder = Effect.fn("Registrar.readOrder")(function* (id: string) {
    const record = yield* integration(() => store.get(REGISTRAR_ORDERS, id));
    if (!record) return undefined;
    const value = yield* evaluate(() => decodeOrder(record.value));
    if (value.id !== id) return yield* failure("registrar_failed", "The stored registrar order has another identity.");
    return { record, value };
  });
  const writeOrder = Effect.fn("Registrar.writeOrder")(function* (current: NonNullable<Effect.Success<ReturnType<typeof readOrder>>>, changes: Partial<typeof Order.Type>) {
    const value = { ...current.value, ...changes, updatedAt: now().toISOString() };
    const record = yield* integration(() => store.compareAndSet(REGISTRAR_ORDERS, value.id, current.record.updatedAt, stored(value), current.record.value));
    if (!record) return yield* failure("registrar_busy", "The registrar order changed concurrently.");
    if (terminal(value)) yield* integration(() => store.delete(activeNamespace, value.id));
    return { record, value };
  });
  const activePage = (limit: number, after?: string) => integration(() => store.page(activeNamespace, { limit, ...(after ? { after } : {}) }));
  const refuseActive = Effect.fn("Registrar.refuseActive")(function* () {
    if ((yield* activePage(1)).records.length) return yield* failure("registrar_busy", "Resolve active registrar orders before replacing or disconnecting this account.");
  });
  const existingOrder = Effect.fn("Registrar.existingOrder")(function* (input: RegistrarOrderInput, principalId: string) {
    const key = yield* integration(() => store.get(REGISTRAR_KEYS, input.idempotencyKey));
    if (!key) return undefined;
    const id = yield* evaluate(() => Schema.decodeUnknownSync(text(80))(key.value));
    let current = yield* readOrder(id);
    if (!current) {
      const active = yield* integration(() => store.get(activeNamespace, id));
      if (!active) return yield* failure("registrar_failed", "The registrar intent has no durable order. No purchase will be retried.");
      const value = yield* evaluate(() => decodeOrder(active.value));
      const recovered = yield* integration(() => store.setIfAbsent(REGISTRAR_ORDERS, id, stored({ ...value, state: "failed", detail: "Interrupted before submission; no purchase was sent." })));
      current = { record: recovered.record, value: yield* evaluate(() => decodeOrder(recovered.record.value)) };
    }
    const row = current.value;
    if (row.kind !== input.kind || row.domain !== input.domain || row.years !== input.years || !samePrice(row.price, input.confirm) || row.principalId !== principalId) return yield* failure("invalid_registrar_request", "This idempotency key belongs to a different purchase intent.");
    return { order: orderView(row), created: false };
  });
  const placeOrder = Effect.fn("Registrar.order")(function* (raw: RegistrarOrderInput, principalId: string) {
    const input = yield* validated(Schema.decodeUnknownSync(RegistrarOrderInputSchema, strict), raw);
    yield* validated(Schema.decodeUnknownSync(text(256)), principalId);
    const existing = yield* existingOrder(input, principalId); if (existing) return existing;
    const connection = yield* configured();
    const active = yield* activePage(201);
    if (active.records.length >= 200 || active.next) return yield* failure("registrar_busy", "At most 200 registrar orders may be active.");
    for (const record of active.records) {
      const row = yield* evaluate(() => decodeOrder(record.value));
      if (row.domain === input.domain) return yield* failure("registrar_busy", "This domain has an unresolved order. Check that order before purchasing again.");
    }
    const contact = input.kind === "register" ? yield* loadContact() : undefined;
    if (input.kind === "register" && !contact) return yield* failure("registrar_contact_missing", "Save a registrant contact before registering a domain.");
    const before = yield* providerValue(Schema.decodeUnknownSync(DomainResult, strict), yield* call(connection, "domain", client => client.domain(input.domain)));
    if (input.kind === "renew" ? !before.owned || !before.expiresAt : before.owned) return yield* failure("domain_unavailable", input.kind === "renew" ? "The registrar does not report ownership and expiry for this domain." : "This registrar account already owns the domain.");
    if (input.kind === "register") {
      const rows = yield* call(connection, "check", client => client.check([input.domain]));
      if (rows.length !== 1 || rows[0]?.domain !== input.domain || rows[0].available !== true) return yield* failure("domain_unavailable", "The domain is not available to register.");
    }
    const price = yield* providerValue(Schema.decodeUnknownSync(RegistrarPriceSchema, strict), yield* call(connection, "quote", client => client.quote(input.domain, input.kind, input.years)));
    if (!samePrice(price, input.confirm)) return yield* new RegistrarError({ code: "price_changed", message: "The registrar price changed. Confirm the new price before ordering.", price });
    const time = now().toISOString();
    const id = `${String(now().getTime()).padStart(16, "0")}-${crypto.randomUUID()}`;
    const value: typeof Order.Type = { schemaVersion: 1, id, kind: input.kind, domain: input.domain, years: input.years, state: "requested", price, idempotencyKey: input.idempotencyKey, principalId, provider: connection.value.provider, sandbox: connection.value.sandbox, connectionRevision: connection.value.revision, createdAt: time, updatedAt: time, attempts: 0, nextReconcileAt: time, ...(input.kind === "renew" ? { previousExpiresAt: before.expiresAt! } : {}) };
    // The active intent precedes the index, so a crash in the two-write gap is recoverable without re-submission.
    yield* integration(() => store.setIfAbsent(activeNamespace, id, stored(value)));
    const claimed = yield* integration(() => store.setIfAbsent(REGISTRAR_KEYS, input.idempotencyKey, id));
    if (!claimed.created) { yield* integration(() => store.delete(activeNamespace, id)); return (yield* existingOrder(input, principalId))!; }
    const initial = yield* integration(() => store.setIfAbsent(REGISTRAR_ORDERS, id, stored(value)));
    if (!initial.created) return yield* failure("registrar_busy", "The order was recovered concurrently; it will not be submitted.");
    const submitting = yield* writeOrder({ record: initial.record, value }, { state: "submitting" });
    const result = yield* Effect.result(call<unknown>(connection, input.kind, client => input.kind === "register"
      ? client.register({ domain: input.domain, years: input.years, contact: contact!.contact, confirm: price })
      : input.kind === "renew" ? client.renew({ domain: input.domain, years: input.years, confirm: price })
      : client.transfer({ domain: input.domain, years: input.years, authCode: input.authCode!, confirm: price }), true));
    let final: Partial<typeof Order.Type>;
    if (result._tag === "Failure") final = { state: result.failure.definite ? "failed" : "unknown", detail: result.failure.definite ? "The registrar refused submission." : "Submission was not confirmed; reconciling with the registrar." };
    else {
      const parsed = yield* Effect.result(providerValue(Schema.decodeUnknownSync(input.kind === "transfer" ? Schema.Struct({ transferId: text(128) }) : Schema.Struct({ registrarOrderId: text(128), chargedAmount: Schema.optionalKey(text(32)), expiresAt: Schema.optionalKey(Timestamp) })), result.success));
      if (parsed._tag === "Failure") final = { state: "unknown", detail: "The registrar did not return a usable receipt; reconciling." };
      else final = input.kind === "transfer" && "transferId" in parsed.success ? { state: "pending_transfer", transferId: parsed.success.transferId } : "registrarOrderId" in parsed.success ? { state: "completed", registrarOrderId: parsed.success.registrarOrderId } : { state: "unknown" };
    }
    const completed = yield* writeOrder(submitting, final);
    return { order: orderView(completed.value), created: true };
  });
  let reconcileAfter: string | undefined;
  const reconcile = Effect.fn("Registrar.reconcile")(function* () {
    const page = yield* activePage(20, reconcileAfter); reconcileAfter = page.next;
    for (const active of page.records) {
      const intent = yield* evaluate(() => decodeOrder(active.value));
      const key = yield* integration(() => store.get(REGISTRAR_KEYS, intent.idempotencyKey));
      if (key?.value !== intent.id) { yield* integration(() => store.delete(activeNamespace, intent.id)); continue; }
      let current = yield* readOrder(intent.id);
      if (!current) {
        const saved = yield* integration(() => store.setIfAbsent(REGISTRAR_ORDERS, intent.id, stored(intent)));
        current = { record: saved.record, value: yield* evaluate(() => decodeOrder(saved.record.value)) };
      }
      if (terminal(current.value)) { yield* integration(() => store.delete(activeNamespace, intent.id)); continue; }
      if (current.value.state === "requested") { yield* writeOrder(current, { state: "failed", detail: "Interrupted before submission; no purchase was sent." }); continue; }
      if (current.value.state === "submitting") { current = yield* writeOrder(current, { state: "unknown", detail: "Submission interrupted; reconciling with the registrar." }); }
      if (Date.parse(current.value.nextReconcileAt) > now().getTime()) continue;
      const row = current.value;
      const checked = yield* Effect.result(Effect.gen(function* () {
        const connection = yield* configured();
        if (connection.value.provider !== row.provider || connection.value.sandbox !== row.sandbox || connection.value.revision !== row.connectionRevision) return yield* failure("registrar_unavailable", "The original registrar connection is unavailable.");
        if (row.state === "pending_transfer" && row.transferId) {
          const result = yield* providerValue(Schema.decodeUnknownSync(Schema.Struct({ state: Schema.Literals(["pending", "completed", "failed"]), detail: Schema.optionalKey(text(200)) })), yield* call(connection, "transfer-status", client => client.transferStatus(row.transferId!)));
          return result.state === "pending" ? undefined : result.state;
        }
        const domain = yield* providerValue(Schema.decodeUnknownSync(DomainResult, strict), yield* call(connection, "domain", client => client.domain(row.domain)));
        if (row.kind === "renew") return domain.owned && domain.expiresAt && row.previousExpiresAt && Date.parse(domain.expiresAt) > Date.parse(row.previousExpiresAt) ? "completed" as const : undefined;
        if (domain.owned) return "completed" as const;
        if (row.kind === "register") {
          const available = yield* call(connection, "check", client => client.check([row.domain]));
          if (available.length === 1 && available[0]?.domain === row.domain && available[0].available === true) return "failed" as const;
        }
        return undefined;
      }));
      const attempts = Math.min(row.attempts + 1, 100);
      const resolved = checked._tag === "Success" ? checked.success : undefined;
      if (checked._tag === "Failure") yield* Effect.logWarning("registrar.reconcile-deferred", { orderId: row.id });
      const old = now().getTime() - Date.parse(row.createdAt) >= 86_400_000;
      yield* writeOrder(current, { ...(resolved ? { state: resolved, detail: resolved === "completed" ? "Confirmed by the registrar." : "The registrar reports the registration or transfer did not complete." } : old ? { detail: "Unconfirmed after 24 hours; check the registrar. This order will never be submitted again." } : {}), attempts, nextReconcileAt: new Date(now().getTime() + Math.min(86_400_000, 60_000 * 2 ** Math.min(attempts - 1, 11))).toISOString() });
    }
  });
  let worker: Fiber.Fiber<void, never> | undefined;
  const reconcilePass = exclusive(reconcile()).pipe(Effect.catch(() => Effect.logWarning("registrar.reconciliation-failed")));

  return {
    providers: () => present(loadConnection().pipe(Effect.map(connection => ({ providers: options.providers.map(({ definition, source, plugin }) => ({ name: definition.name, title: definition.title, credentials: definition.credentials, tokenGuidance: definition.tokenGuidance, source, ...(plugin ? { plugin } : {}), connected: connection?.value.provider === definition.name, ...(connection?.value.provider === definition.name ? { sandbox: connection.value.sandbox } : {}) })) })))),
    connection: () => present(loadConnection().pipe(Effect.map(row => row ? { provider: row.value.provider, sandbox: row.value.sandbox, connected: true as const, revision: row.value.revision } : { connected: false as const, revision: 0 }))),
    connect: (raw: ConnectRegistrarInput) => present(exclusive(Effect.gen(function* () {
      const input = yield* validated(decodeConnectRegistrar, raw);
      const provider = providers.get(input.provider);
      if (!provider) return yield* failure("registrar_unavailable", "The registrar provider is not installed.");
      const names = Object.keys(input.credentials).sort(); const expected = provider.definition.credentials.map(field => field.name).sort();
      if (names.length !== expected.length || names.some((name, i) => name !== expected[i])) return yield* invalid();
      yield* refuseActive();
      const current = yield* loadConnection();
      if (input.expectedRevision !== undefined && input.expectedRevision !== (current?.value.revision ?? 0)) return yield* invalid();
      if (current?.value.revision === Number.MAX_SAFE_INTEGER) return yield* failure("invalid_registrar_request", "The registrar revision is exhausted.");
      const revision = (current?.value.revision ?? 0) + 1;
      const value = { schemaVersion: 1 as const, provider: input.provider, sandbox: input.sandbox, credentials: encryptSecret(JSON.stringify(input.credentials), secretKey), revision, updatedAt: now().toISOString() };
      yield* call({ record: current?.record ?? { namespace: REGISTRAR_CONNECTION, key: "current", updatedAt: "", value: null }, value, definition: provider.definition, credentials: input.credentials }, "connect", client => client.domains({}));
      yield* save(REGISTRAR_CONNECTION, "current", current?.record, value);
      return { provider: input.provider, sandbox: input.sandbox, connected: true as const, revision };
    }))),
    disconnect: () => present(exclusive(Effect.gen(function* () {
      yield* refuseActive();
      const current = yield* loadConnection(); if (!current) return;
      if (!(yield* integration(() => store.compareAndDelete(REGISTRAR_CONNECTION, "current", current.record.updatedAt, current.record.value)))) return yield* invalid();
    }))),
    contact: () => present(loadContact().pipe(Effect.map(row => row ? { contact: row.contact, revision: row.value.revision } : { revision: 0 }))),
    setContact: (raw: SetRegistrarContactInput) => present(exclusive(Effect.gen(function* () {
      const input = yield* validated(decodeSetRegistrarContact, raw); const current = yield* loadContact();
      if (input.expectedRevision !== undefined && input.expectedRevision !== (current?.value.revision ?? 0)) return yield* invalid();
      if (current?.value.revision === Number.MAX_SAFE_INTEGER) return yield* failure("invalid_registrar_request", "The registrar revision is exhausted.");
      const revision = (current?.value.revision ?? 0) + 1;
      yield* save(REGISTRAR_CONTACTS, "default", current?.record, { schemaVersion: 1, encryptedContact: encryptSecret(JSON.stringify(input.contact), contactKey), revision, updatedAt: now().toISOString() });
      return { revision };
    }))),
    check: (domains: readonly string[]) => present(Effect.gen(function* () {
      const input = yield* validated(Schema.decodeUnknownSync(RegistrarAvailabilitySchema, strict), { domains });
      const connection = yield* configured();
      const result = yield* call(connection, "check", client => client.check(input.domains));
      const rows = yield* providerValue(Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ domain: RegistrarDomainSchema, available: Schema.Boolean, premium: Schema.Boolean, price: Schema.optionalKey(RegistrarPriceSchema) })).check(Schema.isMaxLength(20)), strict), result);
      if (rows.length !== domains.length || rows.some((row, i) => row.domain !== domains[i])) return yield* failure("registrar_failed", "The registrar returned an incomplete availability answer.");
      return { domains: rows };
    })),
    quote: (raw: typeof RegistrarQuoteSchema.Type) => present(Effect.gen(function* () {
      const input = yield* validated(Schema.decodeUnknownSync(RegistrarQuoteSchema, strict), raw);
      const connection = yield* configured();
      return yield* providerValue(Schema.decodeUnknownSync(RegistrarPriceSchema, strict), yield* call(connection, "quote", client => client.quote(input.domain, input.kind, input.years)));
    })),
    domains: (cursor?: string) => present(Effect.gen(function* () {
      if (cursor !== undefined && !/^[A-Za-z0-9._~-]{1,256}$/u.test(cursor)) return yield* invalid();
      const connection = yield* configured();
      const result = yield* call(connection, "domains", client => client.domains(cursor === undefined ? {} : { cursor }));
      return yield* providerValue(Schema.decodeUnknownSync(Schema.Struct({ domains: Schema.Array(Schema.Struct({ domain: RegistrarDomainSchema, expiresAt: Schema.optionalKey(Timestamp) })).check(Schema.isMaxLength(50)), next: Schema.optionalKey(text(256)) }), strict), result);
    })),
    setNameservers: (domain: string, nameservers: readonly string[]) => present(exclusive(Effect.gen(function* () {
      yield* validated(Schema.decodeUnknownSync(RegistrarDomainSchema), domain);
      yield* validated(Schema.decodeUnknownSync(RegistrarNameserversSchema, strict), { nameservers });
      if (new Set(nameservers).size !== nameservers.length) return yield* invalid();
      const connection = yield* configured();
      yield* call(connection, "set-nameservers", client => client.setNameservers(domain, nameservers));
    }))),
    order: (input: RegistrarOrderInput, principalId: string) => present(Effect.gen(function* () {
      const result = yield* permit.withPermitsIfAvailable(1)(placeOrder(input, principalId));
      if (Option.isNone(result)) return yield* failure("registrar_busy", "A registrar operation is already in progress.");
      return result.value;
    })),
    orders: (page: { limit?: number; after?: string } = {}) => present(Effect.gen(function* () {
      const limit = page.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || page.after !== undefined && !/^[0-9]{16}-[0-9a-f-]{36}$/u.test(page.after)) return yield* invalid();
      const rows = yield* integration(() => store.page(REGISTRAR_ORDERS, { limit, ...(page.after ? { after: page.after } : {}) }));
      const orders = yield* Effect.forEach(rows.records, record => evaluate(() => orderView(decodeOrder(record.value))));
      return { orders, ...(rows.next ? { next: rows.next } : {}) };
    })),
    getOrder: (id: string) => present(Effect.gen(function* () {
      if (!/^[0-9]{16}-[0-9a-f-]{36}$/u.test(id)) return yield* failure("registrar_order_not_found", "The registrar order does not exist.");
      const current = yield* readOrder(id);
      if (!current) return yield* failure("registrar_order_not_found", "The registrar order does not exist.");
      return orderView(current.value);
    })),
    reconcile: () => present(exclusive(reconcile())),
    start: () => {
      worker ??= Effect.runFork(Effect.gen(function* () { for (;;) { yield* reconcilePass; yield* idle(options.reconcileIntervalMs ?? 60_000); } }));
    },
    close: () => present(Effect.gen(function* () {
      shutdown.abort();
      if (worker) { yield* Fiber.interrupt(worker); worker = undefined; }
      // Wait until an accepted purchase records its outcome before the runtime closes its store.
      yield* exclusive(Effect.void);
    })),
  };
}
export type RegistrarController = ReturnType<typeof createRegistrarController>;
