import { Effect, Fiber, Schema } from "effect";
import {
  authenticateBrowserPasskey, finishBrowserOAuth, passkeyAutofillAvailable, passkeysSupported, registerBrowserPasskey, startBrowserOAuth,
} from "zelavis/sdk/browser";
import { ApiError, array, decode, object } from "./api.ts";
import { button, message, node } from "./dom.ts";
import {
  authFormError, callAccountAuth, callAuth, checkEmail, clearPendingEmail, feedback, field, invalidAccountLink, linkTo,
  readPendingEmail, rememberEmail, show, storageKey, submitWork, tabStorage, takeAccountLinkToken, type AuthContext,
} from "./auth-form.ts";

export interface PublicAuthContext extends AuthContext {
  readonly destination: string;
}

export const publicAuthPaths = [
  "/login", "/sign-up", "/forgot-password", "/reset-password", "/verify-email", "/change-email", "/invitation", "/mfa", "/oauth/callback",
] as const;

const Method = Schema.Struct({ name: Schema.String, signIn: Schema.Boolean, signUp: Schema.Boolean, recovery: Schema.Boolean });
export const AuthMethods = Schema.Struct({
  methods: Schema.Array(Method), registration: Schema.Struct({ enabled: Schema.Boolean }),
});
const Pending = Schema.Struct({
  status: Schema.Literals(["mfa_required", "mfa_enrollment_required"]),
  challenge: Schema.String,
  destination: Schema.String,
});
const Enrollment = Schema.Struct({ totpId: Schema.String, otpauthUri: Schema.String, secret: Schema.String });
const fromJsonPending = Schema.decodeUnknownOption(Schema.fromJsonString(Pending));

const errorOf = (cause: unknown) => cause instanceof ApiError
  ? cause
  : new ApiError({ message: cause instanceof Error ? cause.message : "The browser could not complete sign-in." });
const browserWork = <A>(work: Effect.Effect<A, unknown>) => work.pipe(Effect.mapError(errorOf));

const card = (title: string, ...children: (Node | undefined)[]) => node("section", { class: "auth-card" }, node("h1", {}, title), ...children);
const acceptSignIn = (context: PublicAuthContext, value: unknown, destination = context.destination) =>
  Effect.gen(function* () {
    if (object(value).status === "complete") {
      yield* Effect.sync(() => context.navigate(destination));
      return;
    }
    const pending = yield* decode(Pending, { ...object(value), destination });
    yield* tabStorage(() => sessionStorage.setItem(storageKey(context, "mfa"), JSON.stringify(pending)));
    yield* Effect.sync(() => context.navigate("/mfa"));
  });

const signInOrSignUp = Effect.fn("ui.auth.credentials")(function*(context: PublicAuthContext) {
  const call = callAuth(context);
  const signup = context.path === "/sign-up";
  if (!signup && context.site) {
    // The App's cookies are scoped to its API and ordinary page navigations do not carry them.
    const session = yield* Effect.result(call("session", undefined, "GET"));
    if (session._tag === "Success") {
      const status = feedback();
      const logout = button("Sign out", () => submitWork(context, status, [logout], call("session", undefined, "DELETE"),
        () => context.navigate("/login")));
      return card("You're signed in", node("header", { class: "app-auth-header" },
        node("a", { href: "/" }, "Continue to site"), linkTo(context, "Manage account", "/account")),
        logout, status);
    }
  }

  const methods = yield* call("methods", undefined, "GET").pipe(Effect.flatMap(value => decode(AuthMethods, value)));
  const available = (name: string) => methods.methods.some(method => method.name === name && (signup ? method.signUp : method.signIn));
  const canSignUp = methods.registration.enabled && methods.methods.some(method => method.signUp);
  if (signup && !canSignUp) {
    if (!context.site) context.navigate("/login?registration=closed");
    return card("Registration is closed", linkTo(context, "Login", "/login"));
  }

  const usernamePassword = available("usernamePassword");
  const emailPassword = available("emailPassword");
  const passkey = available("usernamePasskey") && passkeysSupported();
  const hasPassword = usernamePassword || emailPassword;
  const identifier = field("identifier", emailPassword && (usernamePassword || passkey) ? "Email or username" : emailPassword ? "Email" : "Username",
    { id: signup ? "signup-identifier" : "identifier", autocomplete: passkey && !signup ? "username webauthn" : "username", maxlength: "254", required: "" });
  const passwordAttrs = { type: "password", autocomplete: signup ? "new-password" : "current-password", maxlength: "1024", ...(signup ? { minlength: "15" } : {}) };
  const password = field("password", "Password", { id: signup ? "signup-password" : "password", ...passwordAttrs, required: "" });
  const confirm = field("confirm", "Confirm password", { ...passwordAttrs, required: "" });
  const displayName = field("displayName", "Display name (optional)", { autocomplete: "name", maxlength: "120" });
  const status = feedback();
  const submit = node("button", { type: "submit", class: "primary" }, signup ? "Create account" : "Login");
  const form = node("form", { class: "form", method: "post" },
    hasPassword || passkey ? identifier.label : undefined, hasPassword && signup ? displayName.label : undefined,
    hasPassword ? password.label : undefined, hasPassword && signup ? confirm.label : undefined);
  let autofillFiber: Fiber.Fiber<unknown, never> | undefined;
  const stopAutofill = Effect.suspend(() => autofillFiber === undefined ? Effect.void : Fiber.interrupt(autofillFiber));
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (!hasPassword || submit.disabled) return;
    const value = identifier.input.value.trim();
    const email = emailPassword && (!usernamePassword || value.includes("@"));
    const fieldName = email ? "email" : "username";
    if (email ? !emailPassword : !usernamePassword) {
      show(status, email ? "Email sign-in is unavailable here." : "Enter your email address.", true);
      return;
    }
    if (signup && password.input.value !== confirm.input.value) {
      show(status, "The passwords do not match.", true);
      confirm.input.focus();
      return;
    }
    const route = `${fieldName}-password/${signup ? "sign-up" : "sign-in"}`;
    const body = {
      [fieldName]: value, password: password.input.value,
      ...(signup && displayName.input.value.trim() ? { displayName: displayName.input.value.trim() } : {}),
    };
    const needsEmail = signup && email;
    const work = call(route, body).pipe(Effect.flatMap(result => needsEmail
      ? rememberEmail(context, "signup", result)
      : acceptSignIn(context, result)), Effect.catch(error => {
        if (signup && error.code === "registration_closed") {
          return Effect.sync(() => context.navigate(context.site ? "/sign-up" : "/login?registration=closed"));
        }
        return Effect.fail(error);
      }), Effect.ensuring(Effect.sync(() => { password.input.value = ""; confirm.input.value = ""; })));
    submitWork(context, status, [submit], Effect.andThen(stopAutofill, work), () => {
      if (needsEmail) { show(status, checkEmail); form.replaceChildren(status); }
    });
  });

  let choosingPasskey = false;
  const passkeyButton = passkey ? button(signup ? "Create account with a passkey" : "Sign in with a passkey", () => {
    const username = identifier.input.value.trim();
    if (!username) { identifier.input.focus(); show(status, "Enter your username.", true); return; }
    choosingPasskey = true;
    const work = browserWork(signup ? registerBrowserPasskey(call, username) : authenticateBrowserPasskey(call, username));
    submitWork(context, status, [passkeyButton!], stopAutofill.pipe(Effect.andThen(work), Effect.flatMap(result => acceptSignIn(context, result))), () => {});
  }) : undefined;
  form.append(status);
  if (hasPassword) form.append(submit);
  if (passkeyButton) form.append(passkeyButton);
  if (passkey && !signup) {
    // This fiber belongs to the screen. Conditional mediation needs the autocomplete input mounted first.
    autofillFiber = yield* Effect.forkScoped(Effect.sleep("200 millis").pipe(
      Effect.andThen(passkeyAutofillAvailable),
      Effect.flatMap(supported => supported && identifier.input.isConnected && !choosingPasskey
        ? browserWork(authenticateBrowserPasskey(call)).pipe(
          Effect.flatMap(result => choosingPasskey ? Effect.void : acceptSignIn(context, result)))
        : Effect.void),
      Effect.catch(error => Effect.sync(() => {
        if (!choosingPasskey && error.message !== "The passkey prompt was cancelled.") show(status, error.message, true);
      })),
    ));
  }

  const providers = methods.methods.some(method => method.name.startsWith("oauth:") && available(method.name)) ? array(object(yield* call("oauth/providers", undefined, "GET")).providers).map(object) : [];
  const oauth = providers.flatMap(({ name, title }) => typeof name === "string" && typeof title === "string" && available(`oauth:${name}`)
    ? [button(`Continue with ${title}`, () => context.run(browserWork(startBrowserOAuth(call, name, `${context.mount}/oauth/callback`, context.destination))))]
    : []);
  const closedNotice = new URL(location.href).searchParams.get("registration") === "closed" && !canSignUp;
  return card(signup ? "Create an account" : context.site ? "Login" : "Login to Zelavis",
    closedNotice ? message("Registration is closed.") : undefined,
    hasPassword || passkey || oauth.length ? form : message("No sign-in methods are available.", true), ...oauth,
    signup ? linkTo(context, "Back to login", "/login") : undefined,
    !signup && canSignUp ? linkTo(context, "Create account", "/sign-up") : undefined,
    !signup && methods.methods.some(method => method.recovery) ? linkTo(context, "Forgot password?", "/forgot-password") : undefined);
});

const emailPage = Effect.fn("ui.auth.email")(function*(context: PublicAuthContext) {
  const call = callAuth(context);
  const status = feedback();
  const back = linkTo(context, "Back to login", "/login");
  if (context.path === "/forgot-password") {
    const email = field("email", "Email", { type: "email", autocomplete: "email", required: "" });
    const submit = node("button", { type: "submit", class: "primary" }, "Send reset link");
    const form = node("form", { class: "form", method: "post" }, email.label, status, submit);
    form.addEventListener("submit", event => {
      event.preventDefault();
      submitWork(context, status, [submit], call("email-password/recovery/start", { email: email.input.value.trim() }).pipe(
        Effect.flatMap(value => rememberEmail(context, "recovery", value)),
      ), () => show(status, "Check your email for a password reset link."));
    });
    return card("Forgot password", form, back);
  }

  const recovery = context.path === "/reset-password";
  const change = context.path === "/change-email";
  const title = recovery ? "Reset password" : change ? "Change primary email" : "Verify email";
  const emailCode = takeAccountLinkToken();
  const stored = yield* readPendingEmail(context, recovery ? "recovery" : change ? "change" : "signup");
  const pending = stored._tag === "Some" ? stored.value : undefined;
  const accountLink = linkTo(context, "Back to email addresses", "/account/emails");
  const signedInFlow = change || pending?.kind === "add";
  if (!emailCode || !pending) {
    return card(title, message(`${invalidAccountLink} Open the link in the tab that requested it.`, true), signedInFlow ? accountLink : back);
  }
  const claim = { emailCode, browserSecret: pending.browserSecret };
  if (signedInFlow) {
    const confirm = button(change ? "Confirm new primary email" : "Verify email address", () =>
      submitWork(context, status, [confirm], callAccountAuth(context)(change ? "email-password/change-email/complete" : "emails/add/complete", claim).pipe(
        Effect.tap(() => clearPendingEmail(context, pending)),
      ), () => {
        confirm.remove();
        show(status, change ? "Primary email changed." : "Email address added.");
      }), { class: "primary" });
    return card(title, confirm, status, accountLink);
  }
  const complete = (path: string, extra: object = {}) => call(path, { ...claim, ...extra }).pipe(
    Effect.tap(() => clearPendingEmail(context, pending)),
    Effect.flatMap(value => acceptSignIn(context, value)),
  );
  if (!recovery) {
    const result = yield* Effect.result(complete("email-password/complete-sign-up"));
    return card(title, result._tag === "Success" ? message("Email verified.") : message(authFormError(result.failure), true), back);
  }

  if (object(yield* call("email-password/recovery/check", claim)).valid !== true) return card(title, message(invalidAccountLink, true), back);
  const attrs = { type: "password", autocomplete: "new-password", minlength: "15", maxlength: "1024", required: "" };
  const password = field("password", "New password", attrs);
  const confirm = field("confirm", "Confirm password", attrs);
  const submit = node("button", { type: "submit", class: "primary" }, "Reset password");
  const form = node("form", { class: "form", method: "post" }, password.label, confirm.label, status, submit);
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (password.input.value !== confirm.input.value) { show(status, "The passwords do not match.", true); return; }
    submitWork(context, status, [submit], complete("email-password/recovery/complete", { newPassword: password.input.value }), () => {
      password.input.value = "";
      confirm.input.value = "";
    });
  });
  return card(title, form, back);
});

function invitationPage(context: PublicAuthContext) {
  const token = takeAccountLinkToken("token");
  if (token === undefined) return card("Accept invitation", message(invalidAccountLink, true), linkTo(context, "Back to login", "/login"));
  const call = callAuth(context);
  const status = feedback();
  const username = field("username", "Username", { autocomplete: "username", maxlength: "64", required: "" });
  const attrs = { type: "password", autocomplete: "new-password", minlength: "15", maxlength: "1024", required: "" };
  const password = field("password", "Password", attrs);
  const confirm = field("confirm", "Confirm password", attrs);
  const submit = node("button", { type: "submit", class: "primary" }, "Accept invitation");
  const signIn = node("div", { hidden: "" },
    linkTo(context, "Sign in to accept", "/login", { target: "_blank", rel: "noopener noreferrer" }),
    node("p", {}, "Sign in to the invited account in the new tab, then return here to accept."));
  const existing = button("Accept with signed-in account", () => accept());
  function accept(credentials?: { username: string; password: string }) {
    const work = call("invitations/accept", { token, ...credentials }).pipe(
      Effect.flatMap(value => acceptSignIn(context, value, context.site ? "/" : "/projects")),
      Effect.ensuring(Effect.sync(() => { password.input.value = ""; confirm.input.value = ""; })),
      Effect.result,
    );
    submitWork(context, status, [submit, existing], work, result => {
      if (result._tag === "Success") return;
      const error = result.failure;
      signIn.hidden = error.code !== "invitation_requires_sign_in" && error.code !== "not_signed_in";
      show(status, authFormError(error), true);
    });
  }
  const form = node("form", { class: "form", method: "post" },
    node("h2", {}, "Create your account"), username.label, password.label, confirm.label, submit);
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (password.input.value !== confirm.input.value) { show(status, "The passwords do not match.", true); confirm.input.focus(); return; }
    accept({ username: username.input.value.trim(), password: password.input.value });
  });
  return card("Accept invitation", form, existing, status, signIn);
}

const mfaPage = Effect.fn("ui.auth.mfa")(function*(context: PublicAuthContext) {
  const key = storageKey(context, "mfa");
  const pending = fromJsonPending(yield* tabStorage(() => sessionStorage.getItem(key)));
  const back = linkTo(context, "Back to login", "/login");
  if (pending._tag === "None") return card("Verify sign-in", message("Start a new sign-in to verify your account."), back);
  const { challenge, destination, status: kind } = pending.value;
  const enrolling = kind === "mfa_enrollment_required";
  const call = callAuth(context);
  const enrollment = enrolling ? yield* decode(Enrollment, yield* call("mfa/totp", { challenge })) : undefined;
  const code = field("code", enrolling ? "Authenticator code" : "Authenticator or backup code", { autocomplete: "one-time-code", maxlength: "64", required: "" });
  const submit = node("button", { type: "submit", class: "primary" }, "Verify");
  const status = feedback();
  const form = node("form", { class: "form", method: "post" },
    enrollment ? node("div", {}, node("p", {}, "Add this setup key to your authenticator."), node("code", {}, enrollment.secret),
      node("p", {}, node("code", {}, enrollment.otpauthUri))) : undefined,
    code.label, submit, status);
  form.addEventListener("submit", event => {
    event.preventDefault();
    const input = { challenge, code: code.input.value.trim() };
    submitWork(context, status, [submit], (enrollment
      ? call("mfa/totp/confirm", { ...input, totpId: enrollment.totpId })
      : call("mfa/verify", input)).pipe(Effect.tap(() => tabStorage(() => sessionStorage.removeItem(key)))), result => {
      const backupCodes = array(object(result).backupCodes).filter(code => typeof code === "string");
      if (backupCodes.length) {
        form.replaceChildren(node("p", {}, "Save these backup codes. Each code works once."),
          node("pre", {}, backupCodes.join("\n")), button("Continue", () => context.run(acceptSignIn(context, result, destination))));
      } else context.run(acceptSignIn(context, result, destination));
    });
  });
  return card(enrolling ? "Set up an authenticator" : "Verify sign-in", form, back);
});

export const publicAuthScreen = Effect.fn("ui.auth.public")(function*(context: PublicAuthContext) {
  switch (context.path) {
    case "/login":
    case "/sign-up": return yield* signInOrSignUp(context);
    case "/invitation": return invitationPage(context);
    case "/mfa": return yield* mfaPage(context);
    case "/oauth/callback": {
      const result = yield* Effect.result(browserWork(finishBrowserOAuth(callAuth(context))).pipe(
        Effect.flatMap(({ result, returnTo }) => acceptSignIn(context, result,
          returnTo?.startsWith("/") && !returnTo.startsWith("//") && !returnTo.includes("\\") ? returnTo : context.destination)),
      ));
      return card("Provider sign-in", result._tag === "Failure" ? message(authFormError(result.failure), true) : message("Signed in."),
        linkTo(context, "Back to login", "/login"));
    }
    default: return yield* emailPage(context);
  }
});
