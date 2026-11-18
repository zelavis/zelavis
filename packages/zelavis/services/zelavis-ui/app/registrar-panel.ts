import { Effect } from "effect";
import { array, label, object, request } from "./api.ts";
import { button, message, node } from "./dom.ts";
import { badge, card, dataRow, facts, flashNotice, rowsCard, setFlash } from "./page-kit.ts";
import { canAccess } from "./navigation-menu.ts";
import { dropdown } from "./dropdown.ts";
import type { ScreenContext } from "./screens.ts";

/** Registrar account, private contacts and explicit purchases. The URL keeps the purchase key across reloads. */
export const registrarCards = Effect.fn("ui.registrarCards")(function* (context: ScreenContext) {
  const permission = (name: string) => canAccess(context.config.access, { permissions: [name], scope: { type: "system" } });
  if (!permission("server.domains.view")) return [];
  const manage = permission("server.domains.purchase"), api = `${context.config.api.basePath}/runtime/registrar`;
  const providers = array(object(yield* request(`${api}/providers`)).providers).map(object);
  const params = context.url.searchParams;
  const orders = object(yield* request(`${api}/orders${params.has("orderAfter") ? `?after=${encodeURIComponent(params.get("orderAfter")!)}` : ""}`));
  const orderRows = array(orders.orders).map(object);
  const connection = manage ? object(yield* request(`${api}/connection`)) : providers.find(row => row.connected === true) ?? {};
  const savedContact = manage ? object(yield* request(`${api}/contact`)) : {};
  const connected = connection.connected === true;
  const inventory: Record<string, unknown> = connected ? yield* request(`${api}/domains${params.has("registrarCursor") ? `?cursor=${encodeURIComponent(params.get("registrarCursor")!)}` : ""}`).pipe(
    Effect.map(object), Effect.catch(error => error.status === 503 ? Effect.succeed<Record<string, unknown>>({}) : Effect.fail(error))) : {};
  const feedback = node("div", { "aria-live": "polite", "data-registrar-feedback": "" }, flashNotice("Registrar", "registrar"));
  const act = (operation: Effect.Effect<unknown, Error>, text: string, search?: Record<string, string | undefined>) => {
    feedback.replaceChildren(message("Working…"));
    context.run(Effect.result(operation), result => {
      if (result._tag === "Failure") { feedback.replaceChildren(message(result.failure.message, true)); return; }
      setFlash(text, "registrar"); if (search) context.setSearch(search); else context.refresh();
    });
  };
  const field = (name: string, title: string, value = "", type = "text", required = true, max = 255) => {
    const input = node("input", { name, type, value, maxlength: String(max), autocomplete: "off", ...(required ? { required: "" } : {}) });
    return { input, element: node("label", {}, node("span", {}, title), input) };
  };
  const cards: HTMLElement[] = [card("Registrar", feedback,
    node("p", {}, "Register, transfer and renew domains using your own registrar account balance. These are operator purchases; customer domain resale is not available."),
    badge(connected ? connection.sandbox === true ? "Sandbox — test account" : "Live — spends account balance" : manage ? "Not connected" : "Read only"))];

  if (manage && providers.length) {
    const selected = providers.find(row => row.name === (params.get("registrar") ?? connection.provider)) ?? providers[0]!;
    const provider = dropdown({ label: "Registrar provider", value: label(selected.name) }, providers.map(row => ({ value: label(row.name), label: label(row.title) })));
    provider.addEventListener("change", () => context.setSearch({ registrar: provider.value }));
    const sandbox = node("input", { type: "checkbox", name: "sandbox", ...(connection.sandbox !== false ? { checked: "" } : {}) });
    const credentials = array(selected.credentials).map(object).map(row => ({ name: label(row.name), ...field(label(row.name), label(row.label), "", row.secret === true ? "password" : "text", true, 1024) }));
    const form = node("form", { class: "form", "data-registrar-connect": "" }, provider,
      node("p", {}, label(selected.tokenGuidance)),
      node("label", {}, sandbox, node("span", {}, "Use sandbox (test account; no real registration)")),
      ...credentials.map(row => row.element),
      node("p", { class: "muted" }, "Credentials are encrypted and never displayed again. Live mode spends the registrar account balance."),
      node("div", { class: "actions" }, node("button", { type: "submit", class: "primary" }, connected ? "Replace registrar connection" : "Connect registrar"),
        connected ? button("Disconnect registrar", () => act(request(`${api}/connection`, "DELETE"), "Registrar disconnected.")) : undefined));
    form.addEventListener("submit", event => { event.preventDefault(); act(request(`${api}/connection`, "PUT", { provider: label(selected.name), sandbox: sandbox.checked, credentials: Object.fromEntries(credentials.map(row => [row.name, row.input.value])), expectedRevision: Number(connection.revision ?? 0) }), "Registrar connected."); });
    cards.push(card("Registrar connection", form));

    const contact = object(savedContact.contact);
    const specs = [ ["firstName", "First name"], ["lastName", "Last name"], ["organization", "Organization (optional)"], ["address1", "Address"], ["address2", "Address line 2 (optional)"], ["city", "City"], ["stateProvince", "State or province"], ["postalCode", "Postal code"], ["country", "Country (two-letter code)"], ["phone", "Phone (+country.number)"], ["email", "Email"] ] as const;
    const fields = specs.map(([name, title]) => ({ name, ...field(name, `Registrant ${title.toLowerCase()}`, label(contact[name], ""), name === "email" ? "email" : "text", !["organization", "address2"].includes(name), ["city", "stateProvince", "postalCode"].includes(name) ? 50 : name === "country" ? 2 : 255) }));
    const contactForm = node("form", { class: "form", "data-registrar-contact": "" }, ...fields.map(row => row.element), node("button", { type: "submit", class: "primary" }, "Save registrant contact"));
    contactForm.addEventListener("submit", event => { event.preventDefault(); act(request(`${api}/contact`, "PUT", { contact: Object.fromEntries(fields.filter(row => row.input.value !== "").map(row => [row.name, row.input.value])), expectedRevision: Number(savedContact.revision ?? 0) }), "Registrant contact saved."); });
    cards.push(card("Registrant contact", node("p", { class: "muted" }, "The registrar uses this contact for all four registration roles. It is stored encrypted and visible only with domain purchase permission."), contactForm));
  }
  const domain = params.get("registrarDomain") ?? "", kind = params.get("registrarKind") ?? "register", years = Number(params.get("registrarYears") ?? "1");
  if (manage && connected) {
    const name = field("domain", "Domain to acquire or renew", domain, "text", true, 70);
    const operation = dropdown({ label: "Domain operation", value: kind }, [{ value: "register", label: "Register" }, { value: "transfer", label: "Transfer in" }, { value: "renew", label: "Renew" }]);
    const duration = field("years", "Years", String(years), "number", true, 2); duration.input.min = "1"; duration.input.max = "10";
    const form = node("form", { class: "form", "data-registrar-search": "" }, name.element, operation, duration.element, node("button", { type: "submit", class: "primary" }, "Check availability and price"));
    form.addEventListener("submit", event => { event.preventDefault(); context.setSearch({ registrarDomain: name.input.value.trim().toLowerCase(), registrarKind: operation.value, registrarYears: duration.input.value, order: undefined, orderId: undefined, registrarAmount: undefined, registrarCurrency: undefined }); });
    cards.push(card("Acquire or renew a domain", form));
    if (domain) {
      const quoted = yield* request(`${api}/quote`, "POST", { domain, kind, years }).pipe(Effect.map(object), Effect.result);
      if (quoted._tag === "Failure") cards.push(card("Domain quote", message(quoted.failure.message, true)));
      else {
        const quote = quoted.success;
        const result = kind === "register" ? object(array(object(yield* request(`${api}/availability`, "POST", { domains: [domain] })).domains)[0]) : {};
        const available = kind !== "register" || result.available === true;
        const review = button("Review purchase", () => context.setSearch({ order: crypto.randomUUID(), registrarAmount: label(quote.amount), registrarCurrency: label(quote.currency), orderId: undefined }), { class: "primary" });
        if (!available) review.disabled = true;
        cards.push(card("Domain quote", facts([["Domain", domain], ["Operation", kind], ["Availability", kind === "register" ? available ? "Available" : "Unavailable" : "Checked at purchase"], ["Duration", `${years} year(s)`], ["Total", `${label(quote.amount)} ${label(quote.currency)}`]]), result.premium === true ? badge("Premium domain") : undefined, review));
      }
      const key = params.get("order"), amount = params.get("registrarAmount"), currency = params.get("registrarCurrency");
      if (key && amount && currency && !params.has("orderId")) {
        const typed = field("confirmDomain", "Type the domain to confirm", "", "text", true, 70);
        const authCode = field("authCode", "Transfer authorization code", "", "password", true, 256);
        const submit = node("button", { type: "submit", class: "primary", disabled: "" }, "Confirm purchase");
        const status = node("div", { "aria-live": "polite" }); let busy = false;
        const close = () => context.setSearch({ order: undefined, registrarAmount: undefined, registrarCurrency: undefined });
        const form = node("form", { class: "form" }, facts([["Domain", domain], ["Operation", kind], ["Duration", `${years} year(s)`], ["Total", `${amount} ${currency}`], ["Account", connection.sandbox === true ? "Sandbox (test)" : "Live account — real purchase"]]),
          node("p", {}, "Confirming spends the registrar account balance. If the result is unknown, Zelavis checks the registrar and never submits this order again."), typed.element, kind === "transfer" ? authCode.element : undefined, status, node("div", { class: "actions" }, submit, button("Cancel purchase", close)));
        typed.input.addEventListener("input", () => { submit.disabled = busy || typed.input.value !== domain; });
        form.addEventListener("submit", event => {
          event.preventDefault(); if (busy || typed.input.value !== domain) return; busy = true; submit.disabled = true;
          context.run(Effect.result(request(`${api}/orders`, "POST", { kind, domain, years, confirm: { amount, currency, years }, idempotencyKey: key, ...(kind === "transfer" ? { authCode: authCode.input.value } : {}) })), result => {
            authCode.input.value = "";
            if (result._tag === "Failure") { busy = false; submit.disabled = typed.input.value !== domain; status.replaceChildren(message(`${result.failure.message} Keep this order open to retry with the same purchase key.`, true)); return; }
            setFlash("Registrar order recorded.", "registrar"); context.setSearch({ orderId: label(object(result.success).id) });
          });
        });
        const dialog = node("dialog", { class: "account-access-drawer", "aria-label": "Confirm domain purchase", "data-registrar-dialog": "" }, node("h2", {}, "Confirm domain purchase"), form);
        dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
        requestAnimationFrame(() => { if (dialog.isConnected) dialog.showModal(); });
        cards.push(dialog);
      }
    }
  }
  const stateLabel = (value: unknown) => label(value).replaceAll("_", " ").replace(/^./u, c => c.toUpperCase());
  const table = node("table", { "data-registrar-orders": "" }, node("thead", {}, node("tr", {}, ...["Domain", "Operation", "State", "Total"].map(title => node("th", { scope: "col" }, title)))), node("tbody", {}, ...orderRows.map(row => node("tr", { "data-order-key": label(row.idempotencyKey) }, node("td", {}, label(row.domain)), node("td", {}, label(row.kind)), node("td", {}, stateLabel(row.state), row.detail ? node("p", { class: "muted" }, label(row.detail)) : undefined), node("td", {}, `${label(object(row.price).amount)} ${label(object(row.price).currency)}`)))));
  cards.push(card("Registrar orders", orderRows.length ? node("div", { class: "table-wrap" }, table) : message("No registrar orders yet."), node("div", { class: "actions" }, button("Refresh orders", () => context.refresh()), params.has("orderAfter") ? button("First order page", () => context.setSearch({ orderAfter: undefined })) : undefined, typeof orders.next === "string" ? button("Next order page", () => context.setSearch({ orderAfter: orders.next as string })) : undefined)));
  const domains = array(inventory.domains).map(object);
  cards.push(rowsCard("Registered domains", ...domains.map(row => dataRow(label(row.domain), `Expires ${label(row.expiresAt)}`, manage ? node("div", { class: "actions" }, button("Renew", () => context.setSearch({ registrarDomain: label(row.domain), registrarKind: "renew", registrarYears: "1", order: undefined, orderId: undefined })), button("Nameservers", () => context.setSearch({ nameserverDomain: label(row.domain) }))) : undefined)), ...(domains.length ? [] : [dataRow("No domains listed", "Connect a registrar to see its domain inventory.")])));
  if (inventory.next || params.has("registrarCursor")) cards.push(card(undefined, button("First domain page", () => context.setSearch({ registrarCursor: undefined })), typeof inventory.next === "string" ? button("Next domain page", () => context.setSearch({ registrarCursor: inventory.next as string })) : undefined));
  if (manage && params.has("nameserverDomain")) {
    const host = params.get("nameserverDomain")!;
    const nameservers = field("nameservers", "Nameservers (comma separated)", "", "text", true, 1024);
    const form = node("form", { class: "form" }, nameservers.element, node("button", { type: "submit", class: "primary" }, "Save nameservers"));
    form.addEventListener("submit", event => { event.preventDefault(); act(request(`${api}/domains/${encodeURIComponent(host)}/nameservers`, "PUT", { nameservers: nameservers.input.value.split(",").map(value => value.trim().toLowerCase()).filter(Boolean) }), "Nameservers updated.", { nameserverDomain: undefined }); });
    cards.push(card(`Nameservers for ${host}`, form));
  }
  return cards;
});
