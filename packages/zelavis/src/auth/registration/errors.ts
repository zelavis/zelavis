/**
 * Why a sign-up was refused (Zelavis-own). Both fail the transaction the
 * sign-up runs in, so a refused sign-up writes nothing; the routes answer
 * 403 `registration_closed` and 429 `registration_rate_limited`.
 */
import * as Schema from "effect/Schema";

export class RegistrationClosed extends Schema.TaggedError<RegistrationClosed>()("RegistrationClosed", {}) {}

export class RegistrationRateLimited extends Schema.TaggedError<RegistrationRateLimited>()("RegistrationRateLimited", {
  retryAfterMs: Schema.Number,
}) {}

export type RegistrationRefused = RegistrationClosed | RegistrationRateLimited;
