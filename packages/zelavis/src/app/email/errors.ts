import * as Data from "effect/Data";

/** The request's settings, address or message are not acceptable. */
export class EmailSettingsInvalid extends Data.TaggedError("EmailSettingsInvalid")<{ readonly message: string }> {}
/** The settings changed since the caller read them. */
export class EmailSettingsConflict extends Data.TaggedError("EmailSettingsConflict")<{ readonly message: string; readonly revision: number }> {}
/** Email is disabled in this runtime, so nothing can be queued. */
export class EmailDisabled extends Data.TaggedError("EmailDisabled")<{ readonly message: string }> {}
/** The runtime already holds the most deliveries it waits on at once. */
export class EmailOutboxFull extends Data.TaggedError("EmailOutboxFull")<{ readonly message: string }> {}
/** The store, the master secret, a stored record or the transport is unavailable. */
export class EmailUnavailable extends Data.TaggedError("EmailUnavailable")<{ readonly message: string }> {}

/**
 * One SMTP attempt failed. `transient` is retried on the schedule; `permanent` (a 5xx reply, or a server that cannot
 * offer what the settings require) ends the delivery. `reason` is the recorded text, never the server's own words.
 */
export class SmtpFailure extends Data.TaggedError("SmtpFailure")<{
  readonly kind: "transient" | "permanent";
  readonly reason: string;
  readonly code?: number;
}> {}

export type EmailError = EmailSettingsInvalid | EmailSettingsConflict | EmailDisabled | EmailOutboxFull | EmailUnavailable;

export const EMAIL_ERROR_RESPONSES = {
  EmailSettingsInvalid: { status: 400, code: "invalid_email_settings" },
  EmailSettingsConflict: { status: 409, code: "email_settings_conflict" },
  EmailDisabled: { status: 409, code: "email_disabled" },
  EmailOutboxFull: { status: 429, code: "email_outbox_full" },
  EmailUnavailable: { status: 503, code: "email_unavailable" },
} as const;
