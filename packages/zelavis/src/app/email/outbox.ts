import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import { decryptSecret, encryptSecret } from "../../edge/acme-crypto.js";
import type { ZelavisSystemStore, ZelavisSystemStoreRecord, ZelavisSystemStoreValue } from "../../system-store.js";
import {
  decodeDeliveryContent,
  decodeEmailMessage,
  decodeStoredDelivery,
  EMAIL_LEASE_MS,
  EMAIL_MAX_ATTEMPTS,
  EMAIL_PENDING_LIMIT,
  EMAIL_RETENTION_MS,
  EMAIL_RETRY_DELAYS_MS,
  validateLinkBaseUrl,
  type EmailDelivery,
  type EmailDeliveryPage,
  type EmailOutbox,
  type EmailTransportMessage,
  type EmailTransportSettings,
  type StoredDelivery,
} from "./contracts.js";
import { EmailDisabled, EmailOutboxFull, EmailSettingsInvalid, EmailUnavailable, SmtpFailure } from "./errors.js";
import { storeCall, unavailable, type EmailSecret, type EmailSettingsStore } from "./settings.js";

/**
 * The durable outbox: one record per delivery in `zelavis.email.outbox`, keyed by creation time so a page lists the
 * oldest first, and one small record per delivery still waiting in `zelavis.email.due`, holding when it is next due.
 * The worker reads only the due index (at most `EMAIL_PENDING_LIMIT` entries) to find work, so finished deliveries
 * kept for the listing cost it nothing.
 *
 * A delivery moves queued → sending (leased by compare-and-set) → delivered | queued (retry) | failed. Delivery is at
 * least once: a worker that stops after the server accepted a message but before it recorded that resends it once
 * the lease expires, under the same Message-ID, which is the delivery id.
 */

export const OUTBOX_NAMESPACE = "zelavis.email.outbox";
export const DUE_NAMESPACE = "zelavis.email.due";
/** One claim per caller-supplied message id, naming the delivery key it was enqueued under. */
export const OUTBOX_IDS_NAMESPACE = "zelavis.email.outbox.ids";
const contentKey = (secret: string) => `${secret}\u0000zelavis.email.content`;
const KEY_PATTERN = /^\d{15}-[A-Za-z0-9_-]{8,64}$/u;
const PAGE = 100;
/** Deliveries one pass leases at most; the rest wait for the next pass. */
const PASS_LIMIT = 50;
/** Finished deliveries one sweep removes at most. */
const SWEEP_LIMIT = 200;
const SWEEP_EVERY_MS = 60 * 60_000;

export type EmailSend = (settings: EmailTransportSettings, message: EmailTransportMessage) => Effect.Effect<void, SmtpFailure>;

const randomId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};

const iso = (ms: number) => new Date(ms).toISOString();
const stored = (delivery: StoredDelivery) => delivery as unknown as ZelavisSystemStoreValue;

export function publicDelivery(delivery: StoredDelivery): EmailDelivery {
  return {
    id: delivery.id, to: delivery.to, kind: delivery.kind, state: delivery.state, attempts: delivery.attempts,
    createdAt: delivery.createdAt, updatedAt: delivery.updatedAt,
    ...(delivery.nextAttemptAt === undefined ? {} : { nextAttemptAt: delivery.nextAttemptAt }),
    ...(delivery.lastError === undefined ? {} : { lastError: delivery.lastError }),
  };
}

const claimKey = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null && "key" in value && typeof value.key === "string" && KEY_PATTERN.test(value.key) ? value.key : undefined;
const isTerminal = (delivery: StoredDelivery) => delivery.state === "delivered" || delivery.state === "failed";
const dueValue = (value: unknown) =>
  typeof value === "object" && value !== null && "dueAt" in value && typeof value.dueAt === "number" ? value.dueAt : 0;

export interface EmailOutboxOptions {
  readonly store: ZelavisSystemStore;
  readonly secret: EmailSecret;
  readonly settings: EmailSettingsStore;
  readonly now: () => Date;
  /** Whether this runtime has a transport; without one nothing could ever be sent. */
  readonly canSend: boolean;
  /** Tells the worker there is new work. */
  readonly wake: () => void;
}

export interface EmailOutboxApi extends EmailOutbox {
  list(options: { readonly limit: number; readonly after?: string }): Effect.Effect<EmailDeliveryPage, EmailUnavailable | EmailSettingsInvalid>;
}

/** Counts waiting deliveries up to the limit, from the due index alone. */
const countPending = (store: ZelavisSystemStore) => Effect.gen(function* () {
  let count = 0;
  let after: string | undefined;
  for (;;) {
    const page = yield* storeCall(() => store.page(DUE_NAMESPACE, { limit: 500, ...(after === undefined ? {} : { after }) }));
    count += page.records.length;
    if (!page.next || count >= EMAIL_PENDING_LIMIT) return count;
    after = page.next;
  }
});

export function createEmailOutbox(options: EmailOutboxOptions): EmailOutboxApi {
  const { store } = options;
  // One runtime process owns its System Store, so one permit makes the pending bound exact.
  const admission = Semaphore.makeUnsafe(1);
  return {
    linkBase: () => Effect.map(options.settings.read(), (current) =>
      options.canSend && current?.settings.mode === "smtp" && current.settings.linkBaseUrl ? validateLinkBaseUrl(current.settings.linkBaseUrl) : undefined),
    enqueue: (input) => admission.withPermits(1)(Effect.gen(function* () {
      const message = yield* Effect.try({
        try: () => decodeEmailMessage(input),
        catch: () => new EmailSettingsInvalid({ message: "The email message is invalid." }),
      });
      const current = yield* options.settings.read();
      if (current?.settings.mode !== "smtp") return yield* new EmailDisabled({ message: "Email delivery is disabled in this runtime." });
      if (!options.canSend) return yield* unavailable("This runtime has no email transport.");
      const callerId = message.id;
      // A repeated caller id never counts against the pending bound: its delivery already exists, or is rewritten below.
      const claim = callerId === undefined ? undefined : yield* storeCall(() => store.get(OUTBOX_IDS_NAMESPACE, callerId));
      const claimedKey = claim === undefined ? undefined : claimKey(claim.value);
      if (claim !== undefined && claimedKey === undefined) return yield* unavailable("A stored delivery claim is invalid.");
      if (claimedKey !== undefined && (yield* storeCall(() => store.get(OUTBOX_NAMESPACE, claimedKey)))) return { id: callerId! };
      if ((yield* countPending(store)) >= EMAIL_PENDING_LIMIT) {
        return yield* new EmailOutboxFull({ message: `This runtime already holds ${EMAIL_PENDING_LIMIT} deliveries waiting to be sent.` });
      }
      const secret = yield* options.secret;
      const at = options.now().getTime();
      const id = randomId();
      const key = claimedKey ?? `${String(at).padStart(15, "0")}-${id}`;
      // The claim first, naming the key the delivery is about to be written under: a crash before the delivery leaves a
      // claim whose delivery is missing, which the retry above writes under the same key.
      if (callerId !== undefined && claimedKey === undefined) {
        const claimed = yield* storeCall(() => store.setIfAbsent(OUTBOX_IDS_NAMESPACE, callerId, { key }));
        if (!claimed.created) return yield* unavailable("The delivery could not be claimed.");
      }
      const delivery: StoredDelivery = {
        schemaVersion: 1, id, ...(callerId === undefined ? {} : { callerId }), to: message.to, kind: message.kind, state: "queued", attempts: 0,
        content: encryptSecret(JSON.stringify({ subject: message.subject, text: message.text, html: message.html }), contentKey(secret)),
        createdAt: iso(at), updatedAt: iso(at),
      };
      // The delivery first, then its due entry: a crash between them leaves a delivery the hourly sweep re-indexes,
      // never an index entry pointing at nothing.
      const created = yield* storeCall(() => store.setIfAbsent(OUTBOX_NAMESPACE, key, stored(delivery)));
      if (!created.created) return yield* unavailable("The delivery could not be recorded.");
      yield* storeCall(() => store.set(DUE_NAMESPACE, key, { dueAt: at }));
      options.wake();
      return { id: callerId ?? id };
    })),
    list: ({ limit, after }) => Effect.gen(function* () {
      if (after !== undefined && !KEY_PATTERN.test(after)) {
        return yield* new EmailSettingsInvalid({ message: "The deliveries cursor is invalid." });
      }
      const page = yield* storeCall(() => store.page(OUTBOX_NAMESPACE, { limit, ...(after === undefined ? {} : { after }) }));
      const deliveries = yield* Effect.forEach(page.records, (record) => Effect.try({
        try: () => publicDelivery(decodeStoredDelivery(record.value)),
        catch: () => unavailable("A stored delivery is invalid."),
      }));
      return { deliveries, ...(page.next === undefined ? {} : { next: page.next }) };
    }),
  };
}

export interface EmailWorkerOptions {
  readonly store: ZelavisSystemStore;
  readonly secret: EmailSecret;
  readonly settings: EmailSettingsStore;
  readonly send: EmailSend;
  readonly now: () => Date;
}

/** One pass over the due index and, once an hour, the retention sweep. Answers when the next pass is due. */
export function createEmailWorker(options: EmailWorkerOptions) {
  const { store } = options;
  let sweptAt = Number.NEGATIVE_INFINITY;

  const setDue = (key: string, dueAt: number) => storeCall(() => store.set(DUE_NAMESPACE, key, { dueAt }));
  const dropDue = (key: string) => storeCall(() => store.delete(DUE_NAMESPACE, key));

  const finish = (key: string, leased: ZelavisSystemStoreRecord, delivery: StoredDelivery, exit: Exit.Exit<void, SmtpFailure | EmailUnavailable>) =>
    Effect.gen(function* () {
      const at = options.now().getTime();
      const { leaseToken: _token, leaseUntil: _until, nextAttemptAt: _next, lastError: _error, ...rest } = delivery;
      const failure = Exit.isFailure(exit) ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error : undefined;
      if (Exit.isFailure(exit) && failure === undefined) return; // interrupted: the lease expires and another pass resumes it
      const reason = failure?._tag === "SmtpFailure" ? failure.reason : failure ? "no transport" : undefined;
      const final = failure === undefined ? true
        : failure._tag === "SmtpFailure" && failure.kind === "permanent" ? true
          : delivery.attempts >= EMAIL_MAX_ATTEMPTS;
      const next: StoredDelivery = failure === undefined
        ? { ...rest, state: "delivered", updatedAt: iso(at) }
        : final
          ? { ...rest, state: "failed", updatedAt: iso(at), lastError: reason! }
          : { ...rest, state: "queued", updatedAt: iso(at), lastError: reason!, nextAttemptAt: iso(at + EMAIL_RETRY_DELAYS_MS[delivery.attempts - 1]!) };
      const written = yield* storeCall(() => store.compareAndSet(OUTBOX_NAMESPACE, key, leased.updatedAt, stored(next), leased.value));
      // A lost compare-and-set means another worker took the delivery after this lease expired; its answer stands.
      if (!written) return;
      if (next.state === "queued") yield* setDue(key, Date.parse(next.nextAttemptAt!));
      else yield* dropDue(key);
    });

  const attempt = (key: string, transport: EmailTransportSettings, from: { readonly address: string; readonly name?: string }) =>
    Effect.gen(function* () {
      const record = yield* storeCall(() => store.get(OUTBOX_NAMESPACE, key));
      if (!record) return yield* dropDue(key);
      const decoded = yield* Effect.exit(Effect.try({ try: () => decodeStoredDelivery(record.value), catch: () => unavailable() }));
      if (Exit.isFailure(decoded)) {
        yield* Effect.logError("An email delivery record is invalid and was taken out of the queue.");
        return yield* dropDue(key);
      }
      const delivery = decoded.value;
      const at = options.now().getTime();
      if (isTerminal(delivery)) return yield* dropDue(key);
      if (delivery.state === "sending" && Date.parse(delivery.leaseUntil ?? "") > at) return yield* setDue(key, Date.parse(delivery.leaseUntil!));
      if (delivery.state === "queued" && delivery.nextAttemptAt && Date.parse(delivery.nextAttemptAt) > at) {
        return yield* setDue(key, Date.parse(delivery.nextAttemptAt));
      }
      if (delivery.attempts >= EMAIL_MAX_ATTEMPTS) {
        // A lease that expired on the last attempt: that attempt's outcome is unknown and no attempt is left.
        const failed: StoredDelivery = { ...delivery, state: "failed", updatedAt: iso(at), lastError: delivery.lastError ?? "timeout" };
        const { leaseToken: _token, leaseUntil: _until, ...rest } = failed;
        if (yield* storeCall(() => store.compareAndSet(OUTBOX_NAMESPACE, key, record.updatedAt, stored(rest), record.value))) yield* dropDue(key);
        return;
      }
      const leaseUntil = at + EMAIL_LEASE_MS;
      const { nextAttemptAt: _next, ...rest } = delivery;
      const leasedDelivery: StoredDelivery = {
        ...rest, state: "sending", attempts: delivery.attempts + 1, leaseToken: randomId(), leaseUntil: iso(leaseUntil), updatedAt: iso(at),
      };
      const leased = yield* storeCall(() => store.compareAndSet(OUTBOX_NAMESPACE, key, record.updatedAt, stored(leasedDelivery), record.value));
      if (!leased) return;
      yield* setDue(key, leaseUntil);
      const exit = yield* Effect.exit(Effect.gen(function* () {
        const secret = yield* options.secret;
        const content = yield* Effect.try({
          try: () => decodeDeliveryContent(JSON.parse(decryptSecret(delivery.content, contentKey(secret)))),
          catch: () => new SmtpFailure({ kind: "permanent", reason: "invalid message" }),
        });
        yield* options.send(transport, {
          id: delivery.id, from, to: delivery.to, subject: content.subject, text: content.text, html: content.html, date: new Date(at),
        });
      }));
      yield* finish(key, leased, leasedDelivery, exit);
    });

  const sweep = Effect.gen(function* () {
    const at = options.now().getTime();
    let removed = 0;
    let after: string | undefined;
    for (;;) {
      const page = yield* storeCall(() => store.page(OUTBOX_NAMESPACE, { limit: PAGE, ...(after === undefined ? {} : { after }) }));
      for (const record of page.records) {
        const decoded = yield* Effect.exit(Effect.try({ try: () => decodeStoredDelivery(record.value), catch: () => unavailable() }));
        if (Exit.isFailure(decoded)) continue;
        const delivery = decoded.value;
        if (isTerminal(delivery)) {
          if (removed < SWEEP_LIMIT && Date.parse(delivery.updatedAt) + EMAIL_RETENTION_MS < at &&
              (yield* storeCall(() => store.compareAndDelete(OUTBOX_NAMESPACE, record.key, record.updatedAt, record.value)))) {
            removed++;
            if (delivery.callerId !== undefined) yield* storeCall(() => store.delete(OUTBOX_IDS_NAMESPACE, delivery.callerId!));
          }
        } else if (!(yield* storeCall(() => store.get(DUE_NAMESPACE, record.key)))) {
          // Enqueued by a process that stopped before it indexed the delivery.
          yield* setDue(record.key, at);
        }
      }
      if (!page.next) break;
      after = page.next;
    }
    // A claim whose delivery never got written (the enqueuer stopped between them) is released once it is old enough
    // that no retry is coming; the key's leading digits are the time it was made.
    let claimed = 0;
    let claimsAfter: string | undefined;
    for (;;) {
      const page = yield* storeCall(() => store.page(OUTBOX_IDS_NAMESPACE, { limit: PAGE, ...(claimsAfter === undefined ? {} : { after: claimsAfter }) }));
      for (const record of page.records) {
        const key = claimKey(record.value);
        if (key === undefined || claimed >= SWEEP_LIMIT || Number(key.slice(0, 15)) + EMAIL_RETENTION_MS >= at) continue;
        if (!(yield* storeCall(() => store.get(OUTBOX_NAMESPACE, key))) &&
            (yield* storeCall(() => store.compareAndDelete(OUTBOX_IDS_NAMESPACE, record.key, record.updatedAt, record.value)))) claimed++;
      }
      if (!page.next) return;
      claimsAfter = page.next;
    }
  });

  /** One pass; answers the time of the earliest delivery still waiting, if any. */
  const pass = Effect.gen(function* () {
    const at = options.now().getTime();
    if (at - sweptAt >= SWEEP_EVERY_MS) {
      yield* sweep;
      sweptAt = at;
    }
    const current = yield* options.settings.read();
    const transport = current ? yield* options.settings.transport(current.settings) : undefined;
    const from = current?.settings.from;
    const due: string[] = [];
    let earliest = Number.POSITIVE_INFINITY;
    let after: string | undefined;
    for (;;) {
      const page = yield* storeCall(() => store.page(DUE_NAMESPACE, { limit: PAGE, ...(after === undefined ? {} : { after }) }));
      for (const record of page.records) {
        const dueAt = dueValue(record.value);
        if (dueAt <= at && due.length < PASS_LIMIT) due.push(record.key);
        else earliest = Math.min(earliest, dueAt);
      }
      if (!page.next) break;
      after = page.next;
    }
    // Disabled, or no server yet: deliveries wait, and are sent once delivery is configured again.
    if (!transport || !from) return due.length > 0 ? Number.POSITIVE_INFINITY : earliest;
    yield* Effect.forEach(due, (key) => attempt(key, transport, from), { concurrency: 2, discard: true });
    return due.length >= PASS_LIMIT ? at : earliest;
  });

  return { pass };
}
