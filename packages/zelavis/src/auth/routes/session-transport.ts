/**
 * How a signed-in answer reaches the client (Zelavis-own, overview D7). One rule for every method route:
 *
 * - A browser page of this origin (no `Authorization` header, an `Origin` equal to the request's own) gets the two
 *   HttpOnly cookies and a body without tokens.
 * - Every other client (SDK, CLI, native) gets the token bundle in the body.
 *
 * A sign-in the second-factor gate stopped (`mfa_required`, `mfa_enrollment_required`) answers 200 with its status and
 * challenge only: no session exists yet, so neither cookies nor tokens.
 */
import type { ZelavisRouteResponse } from "../../core/index.js";
import { type AuthCookieConfig, responseCookies, writeAuthCookies } from "../core/cookies.js";
import type { SignInComplete, SignInPending } from "../lib/types.js";
import { noStore } from "./errors.js";

export interface SessionTransport {
  readonly cookies: { readonly accessName: string; readonly refreshName: string; readonly apiBase: string; readonly accessPath?: string };
  readonly clock: () => number;
}

/** Whether the request is a browser page of this origin, which gets cookies. */
export const isCookieMode = (request: Request): boolean => {
  if (request.headers.has("authorization") || request.headers.get("x-zelavis-auth-mode") === "bearer") return false;
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
};

export const signInResponse = (
  transport: SessionTransport,
  request: Request,
  result: SignInComplete | SignInPending,
  extra: Readonly<Record<string, unknown>> = {},
): ZelavisRouteResponse => {
  if (result.status !== "complete") {
    return { status: 200, headers: noStore, body: { status: result.status, challenge: result.challenge } };
  }
  const complete = result;
  if (!isCookieMode(request)) {
    return { status: 200, headers: noStore, body: { ...extra, status: "complete", userId: complete.tokens.userId, tokens: complete.tokens } };
  }
  const config: AuthCookieConfig = { ...transport.cookies, secure: new URL(request.url).protocol === "https:" };
  const cookies = responseCookies();
  writeAuthCookies(cookies.store, complete.tokens, config, transport.clock());
  return {
    status: 200,
    headers: [...Object.entries(noStore), ...cookies.headers()],
    body: { ...extra, status: "complete", userId: complete.tokens.userId },
  };
};
