import * as Effect from "effect/Effect";
import { decryptSecret, encryptSecret } from "../../edge/acme-crypto.js";
import { integration } from "../../core/runtime/effect-boundary.js";
import type { ZelavisSystemStore, ZelavisSystemStoreRecord, ZelavisSystemStoreValue } from "../../system-store.js";
import {
  decodeEmailSettingsInput,
  decodeStoredEmailSettings,
  validateLinkBaseUrl,
  type EmailSettings,
  type EmailTransportSettings,
  type StoredEmailSettings,
} from "./contracts.js";
import { EmailSettingsConflict, EmailSettingsInvalid, EmailUnavailable } from "./errors.js";

export const EMAIL_NAMESPACE = "zelavis.email";
const SETTINGS_KEY = "settings";

/** The runtime's master secret, loaded once; anything that cannot provide it leaves email unavailable. */
export type EmailSecret = Effect.Effect<string, EmailUnavailable>;

export const unavailable = (message = "Email is unavailable in this runtime.") => new EmailUnavailable({ message });
const invalid = (message: string) => new EmailSettingsInvalid({ message });

/** Store calls whose failure is this runtime's, never the caller's. */
export const storeCall = <A>(operation: () => A | PromiseLike<A>) =>
  integration(operation).pipe(Effect.mapError(() => unavailable()));

export const smtpPasswordKey = (secret: string) => `${secret}\u0000zelavis.email.smtp`;

export interface StoredSettingsRead {
  readonly record: ZelavisSystemStoreRecord;
  readonly settings: StoredEmailSettings;
}

export interface EmailSettingsStore {
  /** The stored settings and their store record, or undefined before the first save. */
  read(): Effect.Effect<StoredSettingsRead | undefined, EmailUnavailable>;
  /** What a caller may see: the password only as `hasPassword`. */
  view(): Effect.Effect<EmailSettings, EmailUnavailable>;
  update(input: unknown): Effect.Effect<EmailSettings, EmailSettingsInvalid | EmailSettingsConflict | EmailUnavailable>;
  /** The SMTP settings an attempt uses, password decrypted, or undefined unless the mode is `smtp`. */
  transport(settings: StoredEmailSettings): Effect.Effect<EmailTransportSettings | undefined, EmailUnavailable>;
}

export function publicEmailSettings(settings: StoredEmailSettings | undefined): EmailSettings {
  if (!settings) return { revision: 0, mode: "disabled" };
  const { smtp } = settings;
  return {
    revision: settings.revision,
    mode: settings.mode,
    ...(settings.from ? { from: settings.from } : {}),
    ...(settings.linkBaseUrl ? { linkBaseUrl: settings.linkBaseUrl } : {}),
    ...(smtp ? {
      smtp: {
        host: smtp.host, port: smtp.port, security: smtp.security,
        ...(smtp.username === undefined ? {} : { username: smtp.username }),
        hasPassword: smtp.password !== undefined,
      },
    } : {}),
    updatedAt: settings.updatedAt,
  };
}

/** The name the runtime greets a mail server with: its link base's host. */
const clientName = (settings: StoredEmailSettings) => {
  const url = settings.linkBaseUrl ? validateLinkBaseUrl(settings.linkBaseUrl) : undefined;
  return url ? url.hostname.replace(/^\[(.*)\]$/u, "$1") : "localhost";
};

export function createEmailSettingsStore(store: ZelavisSystemStore, secret: EmailSecret, now: () => Date): EmailSettingsStore {
  const read = () => Effect.gen(function* () {
    const record = yield* storeCall(() => store.get(EMAIL_NAMESPACE, SETTINGS_KEY));
    if (!record) return undefined;
    // A record this code did not write is not trusted: email stays unavailable until it is replaced.
    const settings = yield* Effect.try({
      try: () => decodeStoredEmailSettings(record.value),
      catch: () => unavailable("The stored email settings are invalid."),
    });
    return { record, settings };
  });

  const update = (body: unknown) => Effect.gen(function* () {
    const input = yield* Effect.try({ try: () => decodeEmailSettingsInput(body), catch: () => invalid("Invalid email settings.") });
    if (input.linkBaseUrl !== undefined && !validateLinkBaseUrl(input.linkBaseUrl)) {
      return yield* invalid("The link base URL must be https (or http on localhost) without a query or fragment.");
    }
    if (input.mode === "smtp" && (!input.from || !input.linkBaseUrl || !input.smtp)) {
      return yield* invalid("SMTP delivery needs a sender address, a link base URL and SMTP server settings.");
    }
    if (input.smtp?.password !== undefined && input.smtp.password !== "" && input.smtp.username === undefined) {
      return yield* invalid("An SMTP password needs a username.");
    }
    const current = yield* read();
    const revision = current?.settings.revision ?? 0;
    if (input.expectedRevision !== revision) {
      return yield* new EmailSettingsConflict({ message: "The email settings changed. Reload them and try again.", revision });
    }
    // A kept password stays with the server it was given for: changing the host or the user asks for it again.
    const previous = current?.settings.smtp;
    const kept = input.smtp && input.smtp.password === undefined && previous?.password &&
      previous.host === input.smtp.host && previous.username === input.smtp.username ? previous.password : undefined;
    const password = input.smtp?.password
      ? encryptSecret(input.smtp.password, smtpPasswordKey(yield* secret))
      : kept;
    if (input.mode === "smtp" && input.smtp?.username !== undefined && password === undefined) {
      return yield* invalid("An SMTP username needs a password.");
    }
    const next: StoredEmailSettings = {
      schemaVersion: 1,
      revision: revision + 1,
      mode: input.mode,
      ...(input.from ? { from: input.from } : {}),
      ...(input.linkBaseUrl ? { linkBaseUrl: input.linkBaseUrl } : {}),
      ...(input.smtp ? {
        smtp: {
          host: input.smtp.host, port: input.smtp.port, security: input.smtp.security,
          ...(input.smtp.username === undefined ? {} : { username: input.smtp.username }),
          ...(password === undefined ? {} : { password }),
        },
      } : {}),
      updatedAt: now().toISOString(),
    };
    const value = next as unknown as ZelavisSystemStoreValue;
    const written = current
      ? yield* storeCall(() => store.compareAndSet(EMAIL_NAMESPACE, SETTINGS_KEY, current.record.updatedAt, value, current.record.value))
      : (yield* storeCall(() => store.setIfAbsent(EMAIL_NAMESPACE, SETTINGS_KEY, value))).created ? true : undefined;
    if (!written) {
      return yield* new EmailSettingsConflict({ message: "The email settings changed. Reload them and try again.", revision });
    }
    return publicEmailSettings(next);
  });

  return {
    read,
    view: () => Effect.map(read(), (current) => publicEmailSettings(current?.settings)),
    update,
    transport: (settings) => Effect.gen(function* () {
      if (settings.mode !== "smtp" || !settings.smtp) return undefined;
      const { smtp } = settings;
      const stored = smtp.password;
      const password = stored
        ? yield* Effect.flatMap(secret, (key) => Effect.try({
            try: () => decryptSecret(stored, smtpPasswordKey(key)),
            catch: () => unavailable("The stored SMTP password cannot be decrypted."),
          }))
        : undefined;
      return {
        host: smtp.host, port: smtp.port, security: smtp.security,
        ...(smtp.username === undefined ? {} : { username: smtp.username }),
        ...(password === undefined ? {} : { password }),
        clientName: clientName(settings),
      };
    }),
  };
}
