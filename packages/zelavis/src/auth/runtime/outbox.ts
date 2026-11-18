/**
 * The Auth email relay.
 *
 * A mutation that sends an email emits it into the Auth partition's outbox in
 * the same commit as its writes (`tx.emit`), sealed with a key derived from
 * the master secret, because it carries sign-in codes. The relay reads those
 * messages after the commit, opens each, hands it to the runtime's
 * `EmailOutbox` under the message's id, and removes it. The email outbox
 * delivers once per id, so a relay that runs twice, or stops between the
 * hand-off and the removal, still sends one email. A message the email outbox
 * cannot take now (email disabled, full or unavailable) stays for a later run;
 * one that can never be sent (undecodable, refused as invalid) is logged by
 * id and removed.
 */
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { EmailOutbox } from "../../app/email/contracts.js";
import { parseJsonObject } from "../../core/json-validation.js";
import type { TenantApi } from "../../db/database.js";
import { unrefSleep } from "../../db/entities.js";
import type { EventCursor } from "../../db/events.js";
import type { DeliveredMessage } from "../../db/outbox.js";
import { decryptSecret } from "../../edge/acme-crypto.js";
import { AUTH_EMAIL_TOPIC, type AuthEmailPayload, AuthEmailPayloadSchema, type AuthOutboxWaker, authOutboxKey } from "./tx.js";

/** Messages one read takes. */
export const RELAY_PAGE = 50;
/** Reads one run makes at most, so a long log is relayed over several runs. */
export const RELAY_PAGES = 20;

const SealedSchema = Schema.Struct({
  sealed: Schema.Struct({ ciphertext: Schema.String, iv: Schema.String, tag: Schema.String, algorithm: Schema.Literal("AES-256-GCM") }),
});

export interface AuthOutboxRelay extends AuthOutboxWaker {
  /** One run: relay what is owed now. Answers how many messages were handed to the email outbox. */
  readonly run: Effect.Effect<number>;
  /** Run on every `wake` and every `everyMs` until `stop`. */
  readonly start: () => Effect.Effect<{ readonly stop: () => Effect.Effect<void> }>;
}

export function createAuthOutboxRelay(options: {
  readonly tenant: TenantApi;
  readonly outbox: EmailOutbox;
  readonly masterSecret: string;
  readonly everyMs?: number;
}): AuthOutboxRelay {
  const key = authOutboxKey(options.masterSecret);
  const permit = Semaphore.makeUnsafe(1);
  let signal = Deferred.makeUnsafe<void>();
  // Where the last run stopped; a new process starts from the beginning of the log.
  let resume: EventCursor | undefined;

  // The message's email, or undefined when it cannot be opened: not sealed, sealed with another key, or not an email.
  const open = (message: DeliveredMessage): Effect.Effect<AuthEmailPayload | undefined> => Effect.gen(function* () {
    const sealed = Schema.decodeUnknownExit(SealedSchema)(message.payload);
    if (!Exit.isSuccess(sealed)) return undefined;
    const opened = yield* Effect.exit(Effect.try(() => parseJsonObject(decryptSecret({ ...sealed.value.sealed }, key))));
    if (!Exit.isSuccess(opened)) return undefined;
    const payload = Schema.decodeUnknownExit(AuthEmailPayloadSchema)(opened.value);
    return Exit.isSuccess(payload) ? payload.value : undefined;
  });

  const remove = (id: string) => options.tenant.outbox.remove({ ids: [id] });

  // "relayed", "dropped", or "later" when the email outbox cannot take it now.
  const relay = (message: DeliveredMessage) => Effect.gen(function* () {
    const payload = yield* open(message);
    if (payload === undefined) {
      yield* Effect.logWarning(`Auth outbox message ${message.id} cannot be opened; it is removed.`);
      yield* remove(message.id);
      return "dropped" as const;
    }
    const enqueued = yield* options.outbox.enqueue({ id: message.id, ...payload }).pipe(
      Effect.as("enqueued" as const),
      Effect.catchTag("EmailSettingsInvalid", () => Effect.succeed("invalid" as const)),
      // Disabled, full or unavailable: the email outbox may take it later.
      Effect.catch(() => Effect.succeed("later" as const)),
    );
    if (enqueued === "later") return "later" as const;
    if (enqueued === "invalid") {
      yield* Effect.logWarning(`Auth outbox message ${message.id} was refused by the email outbox; it is removed.`);
      yield* remove(message.id);
      return "dropped" as const;
    }
    yield* remove(message.id);
    return "relayed" as const;
  });

  const runOnce = Effect.gen(function* () {
    let relayed = 0;
    for (let page = 0; page < RELAY_PAGES; page += 1) {
      const read = yield* Effect.exit(options.tenant.outbox.read({ topic: AUTH_EMAIL_TOPIC, limit: RELAY_PAGE, ...(resume === undefined ? {} : { after: resume }) }));
      if (Exit.isFailure(read)) {
        // The log was compacted past, or the partition began a new life: read it again from the start next run.
        resume = undefined;
        yield* Effect.logWarning("The Auth outbox is read again from the start.", read.cause);
        return relayed;
      }
      for (const message of read.value.messages) {
        const outcome = yield* relay(message);
        if (outcome === "later") return relayed; // keep `resume` before it
        if (outcome === "relayed") relayed += 1;
        resume = message.cursor;
      }
      if (read.value.cursor !== undefined) resume = read.value.cursor;
      if (!read.value.more) return relayed;
    }
    return relayed;
  });

  const run = permit.withPermit(runOnce).pipe(
    // Interruption is `stop`; anything else is logged and the next run tries again.
    Effect.catchCauseIf((cause) => !Cause.hasInterrupts(cause), (cause) => Effect.as(Effect.logWarning("The Auth outbox relay run failed; it runs again later.", cause), 0)),
    // What is left carries interruption only, which no handler recovers from.
    Effect.orDie,
  );

  return {
    run,
    wake: () => {
      Deferred.doneUnsafe(signal, Effect.void);
    },
    start: () => Effect.gen(function* () {
      const fiber = yield* Effect.forkDetach(Effect.gen(function* () {
        for (;;) {
          signal = Deferred.makeUnsafe<void>(); // a wake during the run below runs it again at once
          const current = signal;
          yield* run;
          yield* Effect.raceFirst(unrefSleep(options.everyMs ?? 60_000), Deferred.await(current));
        }
      }));
      return { stop: () => Fiber.interrupt(fiber) };
    }),
  };
}
