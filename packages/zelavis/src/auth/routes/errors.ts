import * as Effect from "effect/Effect";
import { present } from "../../core/runtime/effect-boundary.js";
import type { ZelavisRouteResponse } from "../../core/index.js";
import type { AuthFailure } from "../core/errors.js";
import type { RegistrationRefused } from "../registration/errors.js";

export const noStore = { "cache-control": "no-store" };

export const errorBody = (status: number, code: string, message: string, headers: Record<string, string> = {}): ZelavisRouteResponse => ({
  status,
  headers: { ...noStore, ...headers },
  body: { error: message, code },
});

/** The auth store could not take the request now; the same request succeeds when repeated. */
export const authBusy = (): ZelavisRouteResponse =>
  errorBody(503, "auth_busy", "Authentication is busy; try again.", { "retry-after": "1" });

/** A sign-up the registration policy refused; nothing was written. */
export const registrationRefused = (error: RegistrationRefused): ZelavisRouteResponse =>
  error._tag === "RegistrationClosed"
    ? errorBody(403, "registration_closed", "Registration is closed.")
    : errorBody(429, "registration_rate_limited", "Too many sign-ups; try again later.", {
        "retry-after": String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))),
      });

const isRegistrationRefused = (error: unknown): error is RegistrationRefused =>
  typeof error === "object" && error !== null &&
  ((error as { _tag?: unknown })._tag === "RegistrationClosed" || (error as { _tag?: unknown })._tag === "RegistrationRateLimited");

/**
 * Run a route's program. A sign-up the registration policy refused answers
 * 403 `registration_closed` or 429 `registration_rate_limited`; a transaction
 * that could not commit or grew past its limits answers 503 `auth_busy`; every
 * other failure is a defect and reaches the dispatcher, which answers 500.
 */
export const respond = (program: Effect.Effect<ZelavisRouteResponse, AuthFailure | RegistrationRefused>): Promise<ZelavisRouteResponse> =>
  present(program.pipe(Effect.catch((error) => Effect.succeed(
    error._tag === "MethodDisabled" ? errorBody(404, "method_disabled", "That sign-in method is not enabled on this runtime.")
      : isRegistrationRefused(error) ? registrationRefused(error) : authBusy(),
  ))));
