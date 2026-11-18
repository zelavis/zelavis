import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";
import type { EmailDisabled, EmailOutboxFull, EmailSettingsInvalid, EmailUnavailable } from "./errors.js";

/**
 * Email delivery contracts, shared by every runtime (the Platform and each native App).
 *
 * A runtime keeps its own settings and outbox in its own System Store; nothing here names a Project.
 */

const forbidden = String.raw`\s@<>()",;:\\[\]\x00-\x1f\x7f`;
const addressPattern = new RegExp(`^[^${forbidden}]+@[^${forbidden}]+\\.[^${forbidden}]+$`, "u");
/** A bare address: no display name, no comments, no control characters, so it can never carry a header. */
export const EmailAddressSchema = Schema.String.check(Schema.isBetweenLength(3, 254), Schema.isPattern(addressPattern));
const DisplayNameSchema = Schema.String.check(Schema.isMaxLength(100), Schema.isPattern(/^[^\x00-\x1f\x7f]*$/u));
const HostSchema = Schema.String.check(Schema.isBetweenLength(1, 253), Schema.isPattern(/^[A-Za-z0-9.:[\]-]+$/u));
const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));
const UsernameSchema = Schema.String.check(Schema.isBetweenLength(1, 256), Schema.isPattern(/^[^\x00-\x1f\x7f]*$/u));
const SecuritySchema = Schema.Literals(["starttls", "tls"]);
const ModeSchema = Schema.Literals(["disabled", "smtp"]);
const FromSchema = Schema.Struct({ address: EmailAddressSchema, name: Schema.optional(DisplayNameSchema) });

export const EMAIL_SETTINGS_BODY_BYTES = 8192;
export const EMAIL_TEST_BODY_BYTES = 1024;
export const EMAIL_SUBJECT_LIMIT = 200;
export const EMAIL_TEXT_LIMIT = 64 * 1024;
export const EMAIL_HTML_LIMIT = 128 * 1024;
/** Deliveries waiting (queued or sending) a runtime holds at once. */
export const EMAIL_PENDING_LIMIT = 1000;
/** How long a delivered or failed delivery stays listed. */
export const EMAIL_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** The wait after each failed attempt; a failure past the last is final. */
export const EMAIL_RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000];
export const EMAIL_MAX_ATTEMPTS = EMAIL_RETRY_DELAYS_MS.length + 1;
/** How long one worker holds a delivery while it sends it. */
export const EMAIL_LEASE_MS = 2 * 60_000;

export const EmailSettingsInputSchema = Schema.Struct({
  expectedRevision: Schema.Natural,
  mode: ModeSchema,
  from: Schema.optional(FromSchema),
  /** Where emailed links start: https, or http on a loopback host; no query or fragment. */
  linkBaseUrl: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
  smtp: Schema.optional(Schema.Struct({
    host: HostSchema,
    port: PortSchema,
    security: SecuritySchema,
    username: Schema.optional(UsernameSchema),
    /** Absent keeps the stored password; "" removes it. */
    password: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
  })),
});
export type EmailSettingsInput = typeof EmailSettingsInputSchema.Type;

export const EmailSettingsSchema = Schema.Struct({
  revision: Schema.Natural,
  mode: ModeSchema,
  from: Schema.optional(FromSchema),
  linkBaseUrl: Schema.optional(Schema.String),
  smtp: Schema.optional(Schema.Struct({
    host: Schema.String,
    port: Schema.Number,
    security: SecuritySchema,
    username: Schema.optional(Schema.String),
    hasPassword: Schema.Boolean,
  })),
  updatedAt: Schema.optional(Schema.String),
});
export type EmailSettings = typeof EmailSettingsSchema.Type;

export const EmailTestInputSchema = Schema.Struct({ to: EmailAddressSchema });
export type EmailTestInput = typeof EmailTestInputSchema.Type;

export const EMAIL_KINDS = ["test", "email-verification", "password-recovery", "invitation", "billing"] as const;
export type EmailKind = typeof EMAIL_KINDS[number];
const KindSchema = Schema.Literals(EMAIL_KINDS);
const StateSchema = Schema.Literals(["queued", "sending", "delivered", "failed"]);
export type EmailDeliveryState = typeof StateSchema.Type;

/** The words a failed attempt is recorded with: never a transcript, never a server's own text. */
export const SMTP_ERROR_TEXTS = ["timeout", "connection failed", "tls failed", "starttls unavailable", "auth unavailable", "invalid message", "no transport"] as const;
const LastErrorSchema = Schema.String.check(Schema.makeFilter((value) =>
  /^SMTP [2-5]\d\d$/u.test(value) || (SMTP_ERROR_TEXTS as readonly string[]).includes(value) ? undefined : "Unknown delivery error."));

export const EmailDeliverySchema = Schema.Struct({
  id: Schema.String,
  to: Schema.String,
  kind: KindSchema,
  state: StateSchema,
  attempts: Schema.Natural,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  nextAttemptAt: Schema.optional(Schema.String),
  lastError: Schema.optional(LastErrorSchema),
});
export type EmailDelivery = typeof EmailDeliverySchema.Type;

export const EmailDeliveryPageSchema = Schema.Struct({
  deliveries: Schema.Array(EmailDeliverySchema),
  next: Schema.optional(Schema.String),
});
export type EmailDeliveryPage = typeof EmailDeliveryPageSchema.Type;

/** A caller's own message id: a repeated one is delivered at most once. */
export const EmailCallerIdSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/u));

export const EmailMessageSchema = Schema.Struct({
  /** When set, `enqueue` creates at most one delivery for this id and answers the id itself every time. */
  id: Schema.optional(EmailCallerIdSchema),
  to: EmailAddressSchema,
  kind: KindSchema,
  subject: Schema.String.check(Schema.isBetweenLength(1, EMAIL_SUBJECT_LIMIT), Schema.isPattern(/^[^\x00-\x1f\x7f]*$/u)),
  text: Schema.String.check(Schema.isMaxLength(EMAIL_TEXT_LIMIT)),
  html: Schema.String.check(Schema.isMaxLength(EMAIL_HTML_LIMIT)),
});
export type EmailMessage = typeof EmailMessageSchema.Type;

/** In-process API other subsystems (identity, billing) enqueue through; never reached over HTTP. */
export interface EmailOutbox {
  /** An invalid message (bad address, header characters, sizes) fails `EmailSettingsInvalid`. */
  enqueue(message: EmailMessage): Effect.Effect<{ readonly id: string }, EmailDisabled | EmailOutboxFull | EmailUnavailable | EmailSettingsInvalid>;
  /** The configured link base, or undefined when email is disabled. */
  linkBase(): Effect.Effect<URL | undefined, EmailUnavailable>;
}

/** What a transport is handed for one attempt: the settings in force, password decrypted, and one message. */
export interface EmailTransportSettings {
  readonly host: string;
  readonly port: number;
  readonly security: "starttls" | "tls";
  readonly username?: string;
  readonly password?: string;
  /** The name this runtime greets the server with (the link base's host). */
  readonly clientName: string;
}
export interface EmailTransportMessage {
  readonly id: string;
  readonly from: { readonly address: string; readonly name?: string };
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly date: Date;
}

// Persisted shapes, decoded strictly on every read: a record this code did not write fails closed.

const EncryptedSecretSchema = Schema.Struct({
  ciphertext: Schema.String,
  iv: Schema.String,
  tag: Schema.String,
  algorithm: Schema.Literal("AES-256-GCM"),
});

export const StoredEmailSettingsSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  revision: Schema.Natural,
  mode: ModeSchema,
  from: Schema.optional(FromSchema),
  linkBaseUrl: Schema.optional(Schema.String),
  smtp: Schema.optional(Schema.Struct({
    host: HostSchema,
    port: PortSchema,
    security: SecuritySchema,
    username: Schema.optional(UsernameSchema),
    password: Schema.optional(EncryptedSecretSchema),
  })),
  updatedAt: Schema.String,
});
export type StoredEmailSettings = typeof StoredEmailSettingsSchema.Type;

export const StoredDeliverySchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{8,64}$/u)),
  /** The caller's own id this delivery was enqueued under, whose claim the retention sweep removes with it. */
  callerId: Schema.optional(EmailCallerIdSchema),
  to: EmailAddressSchema,
  kind: KindSchema,
  state: StateSchema,
  attempts: Schema.Natural.check(Schema.isLessThanOrEqualTo(EMAIL_MAX_ATTEMPTS)),
  content: EncryptedSecretSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  nextAttemptAt: Schema.optional(Schema.String),
  leaseToken: Schema.optional(Schema.String),
  leaseUntil: Schema.optional(Schema.String),
  lastError: Schema.optional(LastErrorSchema),
});
export type StoredDelivery = typeof StoredDeliverySchema.Type;

/** What a delivery's encrypted content holds. */
export const DeliveryContentSchema = Schema.Struct({
  subject: EmailMessageSchema.fields.subject,
  text: EmailMessageSchema.fields.text,
  html: EmailMessageSchema.fields.html,
});

const strict = { onExcessProperty: "error" } as const;
export const decodeEmailSettingsInput = Schema.decodeUnknownSync(EmailSettingsInputSchema, strict);
export const decodeEmailTestInput = Schema.decodeUnknownSync(EmailTestInputSchema, strict);
export const decodeEmailMessage = Schema.decodeUnknownSync(EmailMessageSchema, strict);
export const decodeStoredEmailSettings = Schema.decodeUnknownSync(StoredEmailSettingsSchema, strict);
export const decodeStoredDelivery = Schema.decodeUnknownSync(StoredDeliverySchema, strict);
export const decodeDeliveryContent = Schema.decodeUnknownSync(DeliveryContentSchema, strict);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The link base as a URL: https, or http on a loopback host, with a path kept and no query or fragment. */
export function validateLinkBaseUrl(value: string): URL | undefined {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || value.includes("?") || value.includes("#")) return undefined;
  if (url.protocol === "https:") return url;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) ? url : undefined;
}

export const emailSettingsJsonSchema = Schema.toJsonSchemaDocument(EmailSettingsSchema).schema;
export const emailSettingsInputJsonSchema = Schema.toJsonSchemaDocument(EmailSettingsInputSchema, strict).schema;
export const emailTestInputJsonSchema = Schema.toJsonSchemaDocument(EmailTestInputSchema, strict).schema;
export const emailDeliveryPageJsonSchema = Schema.toJsonSchemaDocument(EmailDeliveryPageSchema).schema;
