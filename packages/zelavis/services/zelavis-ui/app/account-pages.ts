import { Effect, Fiber, Queue, Schema, Scope } from "effect";
import { addBrowserPasskey, passkeysSupported, removeBrowserPasskey } from "zelavis/sdk/browser";
import { ApiError, decode } from "./api.ts";
import { callAccountAuth, callAuth, checkEmail, feedback, field, linkTo, rememberEmail, show, submitWork, type AuthContext } from "./auth-form.ts";
import { button, message, node } from "./dom.ts";
import { qrMaxBytes, qrSvg } from "./qr.ts";
import { accountPageTitles, isAccountPath, type AccountPath } from "../src/account-routes.ts";

const AccountSession = Schema.Struct({
  account: Schema.Struct({ displayName: Schema.optional(Schema.String) }),
});
const Passkeys = Schema.Struct({ passkeys: Schema.Array(Schema.Struct({
  passkeyId: Schema.String, createdAt: Schema.Number, name: Schema.optional(Schema.String),
})) });

type AccountView = {
  context: AuthContext;
  call: ReturnType<typeof callAuth>;
  status: HTMLElement;
  temporary: HTMLElement;
  saved: (text: string) => void;
};

const time = (ms: number) => {
  const date = new Date(ms);
  return node("time", { datetime: date.toISOString() }, date.toLocaleString());
};

function actionForm<A>(view: AccountView, title: string, fields: HTMLElement[], work: () => Effect.Effect<A, ApiError>,
  success: (value: A) => void, label = title) {
  const submit = node("button", { type: "submit" }, title);
  const form = node("form", { class: "form", method: "post", "aria-label": label }, ...fields, submit);
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (submit.disabled) return;
    submitWork(view.context, view.status, [submit], work(), success);
  });
  return form;
}

const passkeyWork = <A>(work: Effect.Effect<A, unknown>) => work.pipe(Effect.mapError(cause =>
  cause instanceof ApiError ? cause : new ApiError({ message: cause instanceof Error ? cause.message : "The browser could not complete the passkey request." })));

const passkeysPage = Effect.fn("ui.account.passkeys")(function*(view: AccountView) {
  const { context, call, status, saved } = view;
  const { passkeys } = yield* decode(Passkeys, yield* call("passkeys", undefined, "GET"));
  if (!passkeys.length) {
    return node("p", {}, "This account has no passkeys. Adding a first passkey needs confirmation with your current sign-in method. That flow is not available yet.");
  }

  const list = node("ul", { class: "account-list" }, ...passkeys.map((passkey, index) => {
    const title = passkey.name ?? `Passkey ${index + 1}`;
    const name = field("name", "Passkey name", { value: passkey.name ?? "", maxlength: "100", required: "" });
    const id = encodeURIComponent(passkey.passkeyId);
    const rename = actionForm(view, "Rename", [name.label],
      () => call(`passkeys/${id}`, { name: name.input.value.trim() }, "PATCH"), () => saved("Passkey renamed."), `Rename ${title}`);
    const remove = button("Remove passkey", () => submitWork(context, status, [remove],
      passkeyWork(removeBrowserPasskey(call, passkey.passkeyId)), () => saved("Passkey removed.")));
    return node("li", {}, node("strong", {}, title), node("p", {}, "Added ", time(passkey.createdAt)), rename, remove);
  }));
  const add = button("Add passkey", () => submitWork(context, status, [add],
    passkeyWork(addBrowserPasskey(call)), () => saved("Passkey added.")), { class: "primary" });
  return node("div", {}, passkeysSupported() ? add : node("p", {}, "This browser cannot use passkeys."), list);
});

const MfaStatus = Schema.Struct({
  totps: Schema.Array(Schema.Struct({ totpId: Schema.String, createdAt: Schema.Number })),
  backupCodesRemaining: Schema.Number,
});
const Enrollment = Schema.Struct({ totpId: Schema.String, otpauthUri: Schema.String, secret: Schema.String });
const BackupCodes = Schema.Struct({ backupCodes: Schema.optional(Schema.Array(Schema.String)) });

const codeField = (label: string) => field("code", label, { autocomplete: "one-time-code", maxlength: "64", required: "" });

function showBackupCodes(view: AccountView, codes: readonly string[] = []) {
  view.temporary.replaceChildren();
  if (codes.length === 0) return;
  const title = node("h2", {}, "Save your backup codes");
  view.temporary.append(node("section", { class: "panel", "aria-label": "New backup codes" },
    title, node("p", {}, "Each code works once. These codes are shown only here."),
    node("pre", {}, codes.join("\n")), button("Done", () => view.temporary.replaceChildren())));
}

const mfaPage = Effect.fn("ui.account.mfa")(function*(view: AccountView) {
  const { call, saved } = view;
  const { totps, backupCodesRemaining } = yield* decode(MfaStatus, yield* call("mfa", undefined, "GET"));
  const setup = node("div");
  const password = field("password", "Current password (if you use one)", {
    type: "password", autocomplete: "current-password", maxlength: "1024",
  });
  const proof = totps.length ? codeField("Existing authenticator or backup code") : undefined;
  const start = actionForm(view, "Set up authenticator", proof ? [password.label, proof.label] : [password.label], () =>
    call("mfa/totp", { password: password.input.value || undefined, code: proof?.input.value.trim() }).pipe(
      Effect.flatMap(result => decode(Enrollment, result)),
    ), enrollment => {
      password.input.value = "";
      if (proof) proof.input.value = "";
      const code = codeField("New authenticator code");
      const qr = new TextEncoder().encode(enrollment.otpauthUri).length <= qrMaxBytes ? qrSvg(enrollment.otpauthUri) : undefined;
      const confirm = actionForm(view, "Confirm authenticator", [code.label], () =>
        call("mfa/totp/confirm", { totpId: enrollment.totpId, code: code.input.value.trim() }).pipe(
          Effect.flatMap(result => decode(BackupCodes, result)),
        ), result => {
          setup.replaceChildren();
          showBackupCodes(view, result.backupCodes);
          saved("Authenticator added.");
        });
      setup.replaceChildren(node("section", { class: "account-setup", "aria-label": "Authenticator setup" },
        node("h2", {}, "Add the account to your authenticator"),
        qr, node("p", {}, "Setup key ", node("code", {}, enrollment.secret)),
        node("p", {}, "Setup URI ", node("code", {}, enrollment.otpauthUri)),
        confirm, button("Cancel setup", () => setup.replaceChildren())));
      code.input.focus();
    });

  const list = node("ul", { class: "account-list", "aria-label": "Authenticators" }, ...totps.map((totp, index) => {
    const code = codeField("Authenticator or backup code");
    return node("li", {}, node("strong", {}, `Authenticator ${index + 1}`), node("p", {}, "Added ", time(totp.createdAt)),
      actionForm(view, "Remove authenticator", [code.label], () =>
        call(`mfa/totp/${encodeURIComponent(totp.totpId)}`, { code: code.input.value.trim() }, "DELETE"), () => {
          view.temporary.replaceChildren();
          saved("Authenticator removed.");
        }, `Remove authenticator ${index + 1}`));
  }));
  const backupCode = codeField("Authenticator or backup code");
  const backup = totps.length ? node("section", { class: "account-section" },
    node("h2", {}, "Backup codes"),
    node("p", {}, `${backupCodesRemaining} remaining. Generating new codes replaces the previous set.`),
    actionForm(view, "Generate new backup codes", [backupCode.label], () =>
      call("mfa/backup-codes", { code: backupCode.input.value.trim() }).pipe(
        Effect.flatMap(result => decode(BackupCodes, result)),
      ), result => {
        showBackupCodes(view, result.backupCodes);
        saved("Backup codes replaced.");
      })) : undefined;
  return node("div", {}, totps.length ? list : node("p", {}, "No authenticator is set up."),
    backup, node("section", { class: "account-section" }, start, setup));
});

const Emails = Schema.Struct({ emails: Schema.Array(Schema.Struct({
  email: Schema.String, isPrimary: Schema.Boolean,
})) });

const emailField = (title: string) => field("email", title, {
  type: "email", autocomplete: "email", maxlength: "254", required: "",
});
const currentPassword = () => field("currentPassword", "Current password", {
  type: "password", autocomplete: "current-password", maxlength: "1024", required: "",
});

const emailsPage = Effect.fn("ui.account.emails")(function*(view: AccountView) {
  const { context, call, status } = view;
  const { emails } = yield* decode(Emails, yield* call("emails", undefined, "GET"));
  const list = node("ul", { class: "account-list", "aria-label": "Verified email addresses" },
    ...emails.map(email => node("li", {}, node("strong", {}, email.email),
      email.isPrimary ? node("span", { class: "badge" }, "Primary") : undefined)));
  const add = emailField("Email address to add");
  const next = emailField("New primary email address");
  const password = currentPassword();
  const sent = () => show(status, `${checkEmail} Open it in this tab.`);
  return node("div", {}, emails.length ? list : node("p", {}, "There are no verified addresses."),
    node("section", { class: "account-section" },
      node("h2", {}, "Add an address"),
      actionForm(view, "Send verification link", [add.label], () =>
        call("emails/add/start", { email: add.input.value.trim() }).pipe(
          Effect.flatMap(result => rememberEmail(context, "add", result)),
        ), () => { add.input.value = ""; sent(); })),
    node("section", { class: "account-section" },
      node("h2", {}, "Change primary address"),
      node("p", {}, "Your new address replaces the current primary address after verification."),
      actionForm(view, "Send change email link", [next.label, password.label], () => {
        const input = { newEmail: next.input.value.trim(), password: password.input.value };
        password.input.value = "";
        return call("email-password/change-email/start", input).pipe(
          Effect.flatMap(result => rememberEmail(context, "change", result)),
        );
      }, () => { next.input.value = ""; sent(); })));
});

function passwordPage(view: AccountView) {
  const current = currentPassword();
  const attrs = { type: "password", autocomplete: "new-password", minlength: "15", maxlength: "1024", required: "" };
  const next = field("newPassword", "New password", attrs);
  const confirm = field("confirmPassword", "Confirm new password", attrs);
  return node("div", {}, node("p", {}, "Changing your password signs out your other sessions."),
    actionForm(view, "Change password", [current.label, next.label, confirm.label], () => {
      if (next.input.value !== confirm.input.value) return Effect.fail(new ApiError({ message: "The passwords do not match." }));
      const input = { currentPassword: current.input.value, newPassword: next.input.value };
      current.input.value = "";
      return view.call("email-password/change-password", input);
    }, () => view.saved("Password changed.")));
}

const Sessions = Schema.Array(Schema.Struct({
  sessionId: Schema.String, creationTime: Schema.Number, lastRefreshedAt: Schema.Number, current: Schema.Boolean,
}));
const Revoked = Schema.Struct({ revoked: Schema.Number });

const sessionsPage = Effect.fn("ui.account.sessions")(function*(view: AccountView) {
  const { context, call, status, saved } = view;
  const sessions = yield* decode(Sessions, yield* call("sessions", undefined, "GET"));
  const revokeOthers = button("Revoke all other sessions", () => submitWork(context, status, [revokeOthers],
    call("sessions/revoke-others").pipe(Effect.flatMap(result => decode(Revoked, result))),
    ({ revoked }) => saved(`Revoked ${revoked} other ${revoked === 1 ? "session" : "sessions"}.`)));
  const list = node("ul", { class: "account-list", "aria-label": "Active sessions" }, ...sessions.map(session => {
    const revoke = session.current
      ? button("Sign out of this session", context.signOut ?? (() =>
        submitWork(context, status, [revoke], call("session", undefined, "DELETE"), () => context.navigate("/login"))))
      : button("Revoke session", () => submitWork(context, status, [revoke],
        call(`sessions/${encodeURIComponent(session.sessionId)}`, undefined, "DELETE"), () => saved("Session revoked.")));
    return node("li", {}, node("strong", {}, session.current ? "Current session" : "Other session"),
      node("p", {}, "Signed in ", time(session.creationTime)),
      node("p", {}, "Last refreshed ", time(session.lastRefreshedAt)), revoke);
  }));
  return node("div", {}, list, sessions.some(session => !session.current) ? revokeOthers : undefined);
});

function loadPage(path: AccountPath, view: AccountView, displayName?: string) {
  switch (path) {
    case "/account/passkeys": return passkeysPage(view);
    case "/account/two-factor": return mfaPage(view);
    case "/account/emails": return emailsPage(view);
    case "/account/password": return Effect.sync(() => passwordPage(view));
    case "/account/sessions": return sessionsPage(view);
    case "/account": return Effect.sync(() =>
      node("p", {}, displayName ? `Signed in as ${displayName}.` : "Manage your sign-in methods and active sessions."));
  }
}

export const accountScreen = Effect.fn("ui.account.screen")(function*(context: AuthContext) {
  const path = context.path;
  if (!isAccountPath(path)) return node("p", {}, "Account page not found.");
  const { account } = yield* decode(AccountSession, yield* callAuth(context)("session", undefined, "GET"));
  const call = callAccountAuth(context);
  const links = node("nav", { class: "account-nav workspace-links", "aria-label": "Account" },
    ...Object.entries(accountPageTitles).map(([route, title]) =>
      linkTo(context, route === "/account" ? "Overview" : title, route, path === route ? { "aria-current": "page" } : {})));
  const status = feedback();
  const data = node("div");
  const temporary = node("div");
  const heading = context.site ? node("header", { class: "app-auth-header" },
    node("a", { href: "/" }, "Back to site"), node("h1", {}, accountPageTitles[path])) : undefined;
  const screen = node("section", { class: "account-page narrow" }, heading, links, status, temporary, node("div", { class: "panel" }, data));
  const changes = yield* Queue.sliding<void>(1);
  const scope = yield* Scope.Scope;
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    temporary.replaceChildren();
    data.replaceChildren();
  }));
  const view: AccountView = {
    context: {
      ...context,
      run: (work, success) => context.run(Effect.flatMap(Effect.forkIn(work, scope), Fiber.join), value => {
        if (screen.isConnected) success?.(value);
      }),
    },
    call, status, temporary,
    saved: text => {
      show(status, text);
      Queue.offerUnsafe(changes, undefined);
    },
  };
  const load = loadPage(path, view, account.displayName).pipe(Effect.tap(page => Effect.sync(() => data.replaceChildren(page))));
  yield* load;
  yield* Effect.forkScoped(Effect.forever(Queue.take(changes).pipe(
    Effect.andThen(load),
    Effect.catch(error => Effect.sync(() => data.replaceChildren(message(error.message, true)))),
  )));
  return screen;
});
