import { Effect, Schema } from "effect";
import { ApiError, decode, object, request } from "./api.ts";
import { message, node } from "./dom.ts";

export function authFormError(error: ApiError): string {
  const retry = error.status === 429 && /^\d{1,4}$/.test(error.retryAfter ?? "") ? ` Try again in ${error.retryAfter} seconds.` : "";
  return error.message + retry;
}

export const recoveryAccepted = "If the account can receive email, we'll send a password reset link.";
export const verificationAccepted = "If the account needs verification, we'll send an email.";
export const checkEmail = "Check your email for a verification link.";
export const invalidAccountLink = "This link is invalid or has expired.";

/** Keep the token only in the form's memory and clear it before calling the API. */
export function takeAccountLinkToken(parameter = "code"): string | undefined {
  const fragment = location.hash;
  if (!fragment) return undefined;
  history.replaceState(history.state, "", location.pathname + location.search);
  const token = new URLSearchParams(fragment.slice(1)).get(parameter);
  return token !== null && /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : undefined;
}

export interface AuthContext {
  readonly api: string;
  readonly prefix: string;
  readonly path: string;
  readonly mount: string;
  readonly site?: boolean;
  readonly signOut?: () => void;
  readonly navigate: (path: string) => void;
  readonly run: <A>(work: Effect.Effect<A, ApiError>, onSuccess?: (value: A) => void) => void;
}

export const callAuth = (context: AuthContext) => (path: string, body?: object, method = "POST") =>
  request(`${context.api}/auth/${path}`, method, body, context.prefix);

export function tabStorage<A>(work: () => A) {
  return Effect.try({ try: work, catch: () => new ApiError({ message: "Allow session storage in this tab to continue." }) });
}

export const linkTo = (context: AuthContext, title: string, path: string, attrs: Record<string, string> = {}) =>
  node("a", { href: `${context.mount}${path}`, class: "auth-link", ...attrs }, title);
export const feedback = () => node("div", { "data-feedback": "", "aria-live": "polite" });
export function show(target: HTMLElement, text: string, error = false) {
  target.dataset.outcome = error ? "error" : "success";
  target.replaceChildren(message(text, error));
}

export const field = (name: string, title: string, attrs: Record<string, string> = {}) => {
  const input = node("input", { name, "aria-label": title, ...attrs });
  return { input, label: node("label", {}, node("span", {}, title), input) };
};

export function submitWork<A>(context: AuthContext, target: HTMLElement, controls: readonly HTMLButtonElement[],
  work: Effect.Effect<A, ApiError>, success: (value: A) => void) {
  if (controls.some(control => control.disabled)) return;
  for (const control of controls) control.disabled = true;
  target.replaceChildren();
  context.run(Effect.result(work).pipe(Effect.ensuring(Effect.sync(() => {
    for (const control of controls) control.disabled = false;
  }))), result => {
    if (result._tag === "Failure") show(target, authFormError(result.failure), true);
    else success(result.success);
  });
}

export const storageKey = (context: AuthContext, kind: string) => `zelavis.auth.${kind}:${context.api}`;
const PendingEmail = Schema.Struct({
  kind: Schema.Literals(["signup", "add", "change", "recovery"]),
  browserSecret: Schema.String,
});
type EmailKind = typeof PendingEmail.Type.kind;
const emailStorageKey = (context: AuthContext, kind: EmailKind) =>
  storageKey(context, `browserSecret.${kind === "signup" || kind === "add" ? "verify" : kind}`);
const decodePending = Schema.decodeUnknownOption(Schema.fromJsonString(PendingEmail));

export function rememberEmail(context: AuthContext, kind: EmailKind, value: unknown) {
  return Effect.gen(function* () {
    const pending = yield* decode(PendingEmail, { ...object(value), kind });
    yield* tabStorage(() => sessionStorage.setItem(emailStorageKey(context, kind), JSON.stringify(pending)));
  });
}

export function readPendingEmail(context: AuthContext, kind: EmailKind) {
  return tabStorage(() => decodePending(sessionStorage.getItem(emailStorageKey(context, kind))));
}

export function clearPendingEmail(context: AuthContext, pending: typeof PendingEmail.Type) {
  const key = emailStorageKey(context, pending.kind);
  return tabStorage(() => {
    const current = decodePending(sessionStorage.getItem(key));
    if (current._tag === "Some" && current.value.browserSecret === pending.browserSecret) sessionStorage.removeItem(key);
  });
}

export const callAccountAuth = (context: AuthContext): ReturnType<typeof callAuth> => {
  const call = callAuth(context);
  return (path, body, method) => {
    const work = call(path, body, method);
    // Some self-service routes report a missing caller themselves. The session
    // route distinguishes access expiry from a signed-out browser.
    return work.pipe(Effect.catch(error => error.code === "not_signed_in"
      ? call("session", undefined, "GET").pipe(Effect.andThen(work))
      : Effect.fail(error)));
  };
};
