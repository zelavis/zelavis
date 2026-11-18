import { Effect, Schema } from "effect";
import { decode, request, type ApiError } from "./api.ts";
import { button, field, message, node } from "./dom.ts";
import { dropdown } from "./dropdown.ts";
import { card } from "./page-kit.ts";
import type { ScreenContext } from "./screens.ts";

/**
 * Email delivery for one runtime: the Platform's own (`/email`), or one App's through its Gateway routes
 * (`/runtime/projects/:id/email`). The same three cards serve both: SMTP settings, a test send, and the deliveries.
 */

const EmailSettings = Schema.Struct({
  revision: Schema.Natural,
  mode: Schema.Literals(["disabled", "smtp"]),
  from: Schema.optional(Schema.Struct({ address: Schema.String, name: Schema.optional(Schema.String) })),
  linkBaseUrl: Schema.optional(Schema.String),
  smtp: Schema.optional(Schema.Struct({
    host: Schema.String, port: Schema.Number, security: Schema.Literals(["starttls", "tls"]),
    username: Schema.optional(Schema.String), hasPassword: Schema.Boolean,
  })),
  updatedAt: Schema.optional(Schema.String),
});
type EmailSettings = typeof EmailSettings.Type;
const Delivery = Schema.Struct({
  id: Schema.String, to: Schema.String, kind: Schema.String, state: Schema.Literals(["queued", "sending", "delivered", "failed"]),
  attempts: Schema.Number, createdAt: Schema.String, updatedAt: Schema.String,
  nextAttemptAt: Schema.optional(Schema.String), lastError: Schema.optional(Schema.String),
});
const DeliveryPage = Schema.Struct({ deliveries: Schema.Array(Delivery), next: Schema.optional(Schema.String) });
type DeliveryPage = typeof DeliveryPage.Type;

const STATES = { queued: "Queued", sending: "Sending", delivered: "Delivered", failed: "Failed" } as const;
const PAGE_SIZE = 50;
/** How often, and how many times, the listing is read again while a delivery it shows is still waiting. */
const FOLLOW_MS = 1000;
const FOLLOW_LIMIT = 30;

const inputOf = (label: HTMLElement) => label.querySelector("input") as HTMLInputElement;

function unavailable(error: ApiError, projectId: string | undefined) {
  return message(error.status === 404 && projectId
    ? "Email settings are unavailable. Check that the Project exists and its App engine supports email delivery."
    : error.message, true);
}

export const emailSettingsCards = Effect.fn("ui.emailSettingsCards")(function*(context: ScreenContext, projectId?: string) {
  const base = projectId
    ? `${context.config.api.basePath}/runtime/projects/${encodeURIComponent(projectId)}/email`
    : `${context.config.api.basePath}/email`;
  const read = request(`${base}/settings`).pipe(Effect.flatMap(value => decode(EmailSettings, value)));
  const after = context.url.searchParams.get("emailAfter") ?? undefined;
  const listing = (cursor?: string) => request(`${base}/deliveries?${new URLSearchParams({ limit: String(PAGE_SIZE), ...(cursor ? { after: cursor } : {}) })}`)
    .pipe(Effect.flatMap(value => decode(DeliveryPage, value)));
  const [initial, firstPage] = yield* Effect.all([Effect.result(read), Effect.result(listing(after))], { concurrency: 2 });
  if (initial._tag === "Failure") return [card("Email delivery", unavailable(initial.failure, projectId))];

  let settings = initial.success;
  const mode = dropdown({ name: "mode", label: "Delivery" }, [{ value: "disabled", label: "Disabled" }, { value: "smtp", label: "SMTP" }]);
  const fromAddress = field("fromAddress", "Sender address", "email", "", false);
  const fromName = field("fromName", "Sender name", "text", "", false);
  const linkBase = field("linkBaseUrl", "Link base URL", "url", "", false);
  const host = field("host", "SMTP host", "text", "", false);
  const port = field("port", "Port", "number", "", false);
  const security = dropdown({ name: "security", label: "Security" }, [{ value: "starttls", label: "STARTTLS" }, { value: "tls", label: "TLS" }]);
  const username = field("username", "Username", "text", "", false);
  const password = field("password", "Password", "password", "", false);
  inputOf(password).autocomplete = "new-password";
  const removePassword = node("input", { type: "checkbox", name: "removePassword" });
  const removeLabel = node("label", { class: "checkbox-field" }, removePassword, "Remove the stored password");
  const save = node("button", { type: "submit", class: "primary" }, "Save");
  const status = node("div", { role: "status", class: "muted" });
  const show = (current: EmailSettings, notice: string) => {
    settings = current;
    mode.setValue(current.mode);
    inputOf(fromAddress).value = current.from?.address ?? "";
    inputOf(fromName).value = current.from?.name ?? "";
    inputOf(linkBase).value = current.linkBaseUrl ?? "";
    inputOf(host).value = current.smtp?.host ?? "";
    inputOf(port).value = current.smtp ? String(current.smtp.port) : "587";
    security.setValue(current.smtp?.security ?? "starttls");
    inputOf(username).value = current.smtp?.username ?? "";
    inputOf(password).value = "";
    inputOf(password).placeholder = current.smtp?.hasPassword ? "Stored; leave empty to keep it" : "";
    removePassword.checked = false;
    removeLabel.hidden = current.smtp?.hasPassword !== true;
    save.disabled = false;
    status.textContent = notice;
  };
  show(settings, settings.mode === "smtp" ? `Sending through ${settings.smtp?.host ?? "SMTP"}.` : "Email delivery is disabled.");
  const form = node("form", { class: "form", "aria-label": "Email settings" },
    node("label", {}, node("span", {}, "Delivery"), mode),
    fromAddress, fromName, linkBase,
    node("p", { class: "muted" }, "Emailed links (verification, recovery, invitations) start with the link base URL."),
    host, port, node("label", {}, node("span", {}, "Security"), security), username, password, removeLabel,
    save, status);
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    const text = (label: HTMLElement) => inputOf(label).value.trim();
    const smtpHost = text(host);
    const secret = inputOf(password).value;
    const input = {
      expectedRevision: settings.revision,
      mode: mode.value,
      ...(text(fromAddress) ? { from: { address: text(fromAddress), ...(text(fromName) ? { name: text(fromName) } : {}) } } : {}),
      ...(text(linkBase) ? { linkBaseUrl: text(linkBase) } : {}),
      ...(smtpHost ? {
        smtp: {
          host: smtpHost, port: Number(text(port) || "587"), security: security.value,
          ...(text(username) ? { username: text(username) } : {}),
          ...(removePassword.checked ? { password: "" } : secret ? { password: secret } : {}),
        },
      } : {}),
    };
    const update = Effect.gen(function* () {
      const result = yield* Effect.result(request(`${base}/settings`, "PUT", input).pipe(Effect.flatMap(value => decode(EmailSettings, value))));
      if (result._tag === "Success") return { settings: result.success, notice: "Email settings saved." };
      if (result.failure.code !== "email_settings_conflict") return { notice: result.failure.message };
      const current = yield* Effect.result(read);
      if (current._tag === "Failure") return { error: current.failure };
      return { settings: current.success, notice: "Email settings changed. Review the current settings and try again." };
    });
    context.run(update, result => {
      if (result.error) form.replaceChildren(unavailable(result.error, projectId));
      else if (result.settings) show(result.settings, result.notice);
      else {
        save.disabled = false;
        status.textContent = result.notice;
      }
    });
  });

  // Deliveries: oldest first, a page at a time; the cursor is in the URL so a reload shows the same page.
  const rows = node("tbody");
  const pager = node("div", { class: "actions" });
  const listStatus = node("div", { role: "status", class: "muted" });
  const render = (page: DeliveryPage) => {
    rows.replaceChildren(...page.deliveries.map(delivery => node("tr", { "data-delivery": delivery.id },
      node("td", {}, delivery.to),
      node("td", {}, delivery.kind),
      node("td", {}, STATES[delivery.state]),
      node("td", {}, String(delivery.attempts)),
      node("td", {}, delivery.lastError ?? (delivery.nextAttemptAt ? `Next try ${new Date(delivery.nextAttemptAt).toLocaleString()}` : "")),
      node("td", {}, new Date(delivery.updatedAt).toLocaleString()))));
    listStatus.textContent = page.deliveries.length ? "" : "No deliveries yet.";
    pager.replaceChildren(
      ...(after ? [button("First page", () => context.setSearch({ emailAfter: undefined }))] : []),
      ...(page.next ? [button("Next page", () => context.setSearch({ emailAfter: page.next }))] : []),
      button("Refresh", () => context.run(listing(after), render)));
  };
  if (firstPage._tag === "Success") render(firstPage.success);
  else listStatus.textContent = firstPage.failure.message;
  const deliveries = node("div", { class: "table-wrap" }, node("table", { "aria-label": "Email deliveries" },
    node("thead", {}, node("tr", {}, ...["Recipient", "Kind", "State", "Attempts", "Last attempt", "Updated"].map(title => node("th", { scope: "col" }, title)))),
    rows));

  // While a delivery is waiting the listing is read again for a short while, and stops once the page is gone.
  const follow = Effect.gen(function* () {
    for (let round = 0; round < FOLLOW_LIMIT && rows.isConnected; round++) {
      yield* Effect.sleep(FOLLOW_MS);
      const page = yield* listing(after);
      if (!rows.isConnected) return;
      render(page);
      if (!page.deliveries.some(delivery => delivery.state === "queued" || delivery.state === "sending")) return;
    }
  });
  const testTo = field("to", "Send a test to", "email", "", true);
  const testStatus = node("div", { role: "status", class: "muted" });
  const testForm = node("form", { class: "form", "aria-label": "Send a test email" }, testTo, node("button", { type: "submit" }, "Send test email"), testStatus);
  testForm.addEventListener("submit", event => {
    event.preventDefault();
    const to = inputOf(testTo).value.trim();
    context.run(request(`${base}/test`, "POST", { to }), () => {
      testStatus.textContent = "Test email queued.";
      context.run(follow);
    });
  });

  return [
    card("Email delivery", form),
    card("Test email", testForm),
    card("Email deliveries", deliveries, listStatus, pager),
  ];
});
