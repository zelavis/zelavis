import { Effect } from "effect";
import { array, bootstrap, label, object, request } from "./api.ts";
import { button, message, node } from "./dom.ts";
import { stripMount } from "./mount.ts";
import type { ScreenContext } from "./screens.ts";
import { dropdown } from "./dropdown.ts";

/** Sign in, sign out and first-run setup. Setup is the one-time claim of the first owner, then the Edge step. */

/** A `returnTo` from the URL is untrusted: only same-site absolute paths are accepted, so sign-in is never an open redirect. */
export function resolveReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return stripMount(value) || "/";
}

const IN_PROGRESS = "zelavis.setup.in-progress";
/** Marks this tab as mid-wizard after the owner exists, so the wizard stays open for the Edge step. */
const setInProgress = (active: boolean) => Effect.runSync(Effect.try({ try: () => { if (active) sessionStorage.setItem(IN_PROGRESS, "1"); else sessionStorage.removeItem(IN_PROGRESS); }, catch: cause => cause }).pipe(Effect.catch(cause => Effect.logWarning("Session storage is unavailable; setup progress cannot be retained in this tab.", cause))));
const inProgress = () => Effect.runSync(Effect.try({ try: () => sessionStorage.getItem(IN_PROGRESS) === "1", catch: cause => cause }).pipe(Effect.orElseSucceed(() => false)));

const field = (id: string, title: string, attrs: Record<string, string> = {}) => {
  const input = node("input", { id, name: id, "aria-label": title, ...attrs });
  return { input, element: node("label", { for: id }, node("span", {}, title), input) };
};

export const loginScreen = Effect.fn("ui.loginScreen")(function*(context: ScreenContext) {
  const status = yield* bootstrap(context.config);
  const providers = status.providers;
  // `password` is built into Zelavis and covers both identifier kinds; an installation that replaced it falls through to whatever it offers.
  const provider = providers.includes("password") ? "password" : providers[0];
  const acceptsEither = provider === "password";
  const identifier = field("identifier", acceptsEither ? "Email or username" : "Email", { type: acceptsEither ? "text" : "email", placeholder: "owner@example.com", autocomplete: "username", required: "" });
  const password = field("password", "Password", { type: "password", autocomplete: "current-password", required: "" });
  const submit = node("button", { type: "submit", class: "primary" }, "Login");
  if (!provider) submit.setAttribute("disabled", "");
  const form = node("form", { class: "form" }, identifier.element, password.element, ...(providers.length === 0 ? [message("No interactive authentication provider is installed.", true)] : []), submit);
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (!provider || submit.hasAttribute("disabled")) return;
    submit.setAttribute("disabled", "");
    context.run(request(`${context.config.api.basePath}/auth/authenticate/${encodeURIComponent(provider)}`, "POST", { identifier: identifier.input.value, password: password.input.value }).pipe(Effect.ensuring(Effect.sync(() => submit.removeAttribute("disabled")))), () => context.navigate(resolveReturnTo(context.url.searchParams.get("returnTo"))));
  });
  return node("section", { class: "auth-card" }, node("div", { class: "brand" }, "◈ Zelavis"), node("h1", {}, "Login to Zelavis"), node("p", {}, "Authenticate with an installed Zelavis auth provider."), form);
});

export const logoutScreen = Effect.fn("ui.logoutScreen")(function*(context: ScreenContext) {
  // A refusal to sign out (the session is already gone) still ends at the sign-in page.
  yield* request(`${context.config.api.basePath}/auth/session`, "DELETE").pipe(Effect.catch(error => error.status === 401 ? Effect.void : Effect.logWarning("Sign out was refused", error)));
  context.navigate("/login");
  return node("p", { role: "status", class: "muted" }, "Signing out…");
});

const STEPS = [["welcome", "Welcome"], ["owner", "Owner"], ["security", "Security"], ["edge", "Edge"]] as const;
type StepId = (typeof STEPS)[number][0];

/** What the wizard keeps between steps. A step is a URL, so this lives outside the page that draws it. */
const draft = { provider: "", identifier: "", displayName: "", mode: "managed" as "managed" | "external" | "later", hostname: "", completed: false };

export const setupScreen = Effect.fn("ui.setupScreen")(function*(context: ScreenContext) {
  const api = context.config.api.basePath;
  const status = yield* bootstrap(context.config);
  if (!status.required && !inProgress() && !draft.completed) { context.navigate("/login"); return message("Owner setup is complete. Opening sign in…"); }
  const requested = context.url.searchParams.get("step");
  const step: StepId = STEPS.some(entry => entry[0] === requested) ? requested as StepId : "welcome";
  const go = (next: StepId) => context.setSearch({ step: next === "welcome" ? undefined : next });
  if (!draft.provider) draft.provider = status.enrollmentProviders.includes("password") ? "password" : status.enrollmentProviders[0] ?? "";
  const acceptsUsername = draft.provider === "password";
  const canBegin = status.enrollmentProviders.length > 0 && status.required;
  const errors = node("div", { role: "alert" });
  const showError = (text: string) => { errors.replaceChildren(node("p", { class: "danger" }, text)); };

  const index = STEPS.findIndex(entry => entry[0] === step);
  const progress = node("ol", { "aria-label": "Setup progress", class: "setup-progress" }, ...STEPS.map(([id, title], position) => node("li", { class: position <= index || draft.completed ? "done" : "" }, node("span", {}, title))));
  const panel = node("div", { class: "setup-panel" });

  if (draft.completed) {
    panel.append(node("h2", {}, "Zelavis is ready"), node("p", {}, "The owner account is active and this bootstrap route is now permanently closed."), button("Open dashboard", () => { draft.completed = false; context.navigate("/projects"); }, { class: "primary" }));
  } else if (step === "welcome") {
    panel.append(node("h2", {}, "Let’s set up your Platform"),
      node("p", {}, "You’ll create one owner account. Keep the bootstrap token private; it is only used for this claim and never becomes your login credential."),
      node("div", { class: "k-card flush" }, node("div", { class: "k-row" }, node("span", {}, "Bootstrap token"), node("strong", {}, status.required ? "Configured" : "Missing")), node("div", { class: "k-row" }, node("span", {}, "Enrollment providers"), node("strong", {}, String(status.enrollmentProviders.length || "None")))),
      ...(!canBegin ? [message(!status.required ? "Configure ZELAVIS_BOOTSTRAP_TOKEN with at least 32 characters and restart Zelavis." : "Install a credential-enrollment auth provider and restart Zelavis.", true)] : []),
      node("div", { class: "actions end" }, button("Get started", () => go("owner"), { class: "primary", ...(canBegin ? {} : { disabled: "" }) })));
  } else if (step === "owner") {
    const providerSelect = status.enrollmentProviders.length > 1 ? node("label", {}, node("span", {}, "Credential provider"), dropdown({ label: "Credential provider", value: draft.provider }, status.enrollmentProviders.map(name => ({ value: name, label: name })))) : undefined;
    providerSelect?.querySelector("zv-select")?.addEventListener("change", event => { draft.provider = (event.target as HTMLInputElement).value; });
    const identifier = field("setup-identifier", acceptsUsername ? "Email or username" : "Email", { type: acceptsUsername ? "text" : "email", value: draft.identifier, placeholder: "owner@example.com", autocomplete: "username" });
    const display = field("setup-name", "Display name", { value: draft.displayName, placeholder: "Platform Owner", autocomplete: "name" });
    panel.append(node("h2", {}, "Create the Platform owner"), node("p", {}, "This account receives full Platform authority. Additional users can be invited with narrower permissions later."),
      node("div", { class: "form" }, ...(providerSelect ? [providerSelect] : []), identifier.element, display.element), errors,
      node("div", { class: "actions between" }, button("Back", () => go("welcome")), button("Continue", () => {
        if (!identifier.input.value.trim()) { showError(acceptsUsername ? "Enter an email or username." : "Enter an email address."); return; }
        draft.identifier = identifier.input.value.trim(); draft.displayName = display.input.value.trim();
        go("security");
      }, { class: "primary" })));
  } else if (step === "security") {
    const token = field("setup-token", "One-time bootstrap token", { type: "password", autocomplete: "off", minlength: "32", required: "" });
    const password = field("setup-password", "Owner password", { type: "password", autocomplete: "new-password", minlength: "15", required: "" });
    const confirm = field("setup-password-confirm", "Confirm password", { type: "password", autocomplete: "new-password", minlength: "15", required: "" });
    const submit = node("button", { type: "submit", class: "primary" }, "Finish setup");
    const form = node("form", { class: "form" }, token.element, password.element, confirm.element, errors, node("div", { class: "actions between" }, button("Back", () => go("owner")), submit));
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (token.input.value.length < 32) { showError("The bootstrap token must contain at least 32 characters."); return; }
      if (password.input.value.length < 15) { showError("Use an owner password with at least 15 characters."); return; }
      if (password.input.value !== confirm.input.value) { showError("The passwords do not match."); return; }
      const identity = draft.identifier;
      submit.setAttribute("disabled", "");
      context.run(request(`${api}/auth/bootstrap`, "POST", {
        bootstrapToken: token.input.value, provider: draft.provider,
        account: { ...(acceptsUsername && !identity.includes("@") ? { username: identity } : { email: identity }), ...(draft.displayName ? { displayName: draft.displayName } : {}) },
        credential: { identifier: identity, password: password.input.value }
      }).pipe(Effect.ensuring(Effect.sync(() => submit.removeAttribute("disabled")))), () => { setInProgress(true); go("edge"); });
    });
    panel.append(node("h2", {}, "Secure the installation"), node("p", {}, "Prove you control this installation, then choose the password you’ll use to sign in."), form);
  } else {
    const edge = yield* request(`${api}/runtime/edge`).pipe(Effect.result);
    const adapters = edge._tag === "Success" ? array(object(edge.success).adapters).map(object) : [];
    const modes = [["managed", "Managed HTTPS", "Automatic TLS & reachability check"], ["external", "External TLS", "Terminated by upstream proxy"], ["later", "Configure later", "Private listener only"]] as const;
    const hostname = field("edgeHostname", "Platform Hostname (FQDN)", { placeholder: "e.g. panel.example.com", value: draft.hostname });
    const preflight = node("p", { class: "muted", role: "status" });
    const finish = () => { setInProgress(false); draft.completed = true; draft.hostname = ""; context.refresh(); };
    const action = node("button", { type: "button", class: "primary" }, draft.mode === "managed" ? "Verify DNS & enable HTTPS" : draft.mode === "external" ? "Save hostname" : "Finish setup");
    const sync = () => { hostname.element.hidden = draft.mode === "later"; if (draft.mode !== "later" && !draft.hostname.trim()) action.setAttribute("disabled", ""); else action.removeAttribute("disabled"); };
    hostname.input.addEventListener("input", () => {
      draft.hostname = hostname.input.value; sync();
      const name = draft.hostname.trim();
      if (!name) { preflight.textContent = ""; return; }
      Effect.runFork(request(`${api}/runtime/edge/onboard/preflight?hostname=${encodeURIComponent(name)}`).pipe(Effect.map(object), Effect.tap(result => Effect.sync(() => { if (name !== draft.hostname.trim()) return; preflight.textContent = result.valid === true ? result.dnsResolved === true ? "✓ DNS A/AAAA record detected" : "⚠ DNS record not detected yet; ensure DNS points to this server" : label(result.error, ""); })), Effect.catch(() => Effect.sync(() => { preflight.textContent = ""; }))));
    });
    action.addEventListener("click", () => {
      if (draft.mode === "later") { finish(); return; }
      if (!draft.hostname.trim()) { showError("Please enter a platform hostname."); return; }
      context.run(request(`${api}/runtime/edge/onboard`, "POST", { mode: draft.mode, hostname: draft.hostname.trim() }), result => {
        const outcome = object(result);
        if (outcome.status === "failed") showError(label(outcome.error, "Hostname onboarding failed.")); else finish();
      });
    });
    const modeButtons = node("div", { class: "k-grid cols-3", role: "group", "aria-label": "Hostname mode" }, ...modes.map(([id, title, hint]) => {
      const choice = button("", () => { draft.mode = id; context.refresh(); }, { class: `setup-mode${draft.mode === id ? " active" : ""}`, "aria-pressed": String(draft.mode === id) });
      choice.append(node("strong", {}, title), node("small", { class: "muted block" }, hint));
      return choice;
    }));
    sync();
    panel.append(node("h2", {}, "Connect Zelavis Edge"),
      node("p", {}, "Edge owns public routing and TLS independently of Traefik, Caddy, or another reverse proxy. This check never makes an unverified proxy live."),
      ...adapters.map(adapter => node("div", { class: "k-row" }, node("div", {}, node("strong", {}, label(adapter.title)), node("p", { class: "muted" }, object(adapter.detection).version ? `Version ${label(object(adapter.detection).version)}` : label(object(adapter.detection).detail, "Version unavailable"))), node("span", { class: "k-badge" }, adapter.active === true ? "Active" : label(object(adapter.detection).state)))),
      ...(edge._tag === "Failure" ? [node("p", { class: "notice", role: "alert" }, `Edge host integration is not ready yet: ${edge.failure.message} You can finish owner setup without publishing a hostname.`)] : adapters.length === 0 ? [node("p", { class: "muted" }, "No reverse-proxy adapters are installed. Zelavis remains reachable on its private listener until one is provisioned.")] : []),
      node("strong", {}, "Platform Hostname & Ingress"), modeButtons, hostname.element, preflight, errors,
      node("div", { class: "actions between" }, button("Check again", () => context.refresh()), action));
  }
  return node("section", { class: "auth-card setup-card" }, node("div", { class: "brand" }, "◈ Zelavis"), node("p", { class: "muted" }, "First-run setup"), progress, panel);
});

