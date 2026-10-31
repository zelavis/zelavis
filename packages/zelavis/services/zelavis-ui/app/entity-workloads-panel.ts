import { Effect } from "effect";
import { array, label, object, request } from "./api.ts";
import { button, empty, node } from "./dom.ts";
import { card, dataRow, rowsCard } from "./page-kit.ts";
import type { ScreenContext } from "./screens.ts";

/**
 * Below an `entity` workload's editor: the durable entities of the type it handles, and for the one chosen in the URL
 * (`?entity=`, and `?entityTenant=` for another Tenant) its state, the messages it still owes, and a form to send one.
 * Everything goes through the database's entity routes, as the SDK and CLI do.
 */
export const entityWorkloadPanel = Effect.fn("ui.entityWorkloadPanel")(function*(context: ScreenContext, api: string, type: string) {
  const tenant = context.url.searchParams.get("entityTenant") ?? undefined;
  const chosen = context.url.searchParams.get("entity") ?? undefined;
  const tenantQuery = tenant === undefined ? "" : `tenantId=${encodeURIComponent(tenant)}`;
  const at = (id: string, rest: string) => `${api}/database/entities/${encodeURIComponent(type)}/${encodeURIComponent(id)}/${rest}`;
  const withTenant = (path: string) => (tenantQuery === "" ? path : `${path}${path.includes("?") ? "&" : "?"}${tenantQuery}`);
  const listed = object(yield* request(withTenant(`${api}/database/entities/${encodeURIComponent(type)}/list?limit=100`)).pipe(
    Effect.catch(() => Effect.succeed({ entities: [] }))));
  const entities = array(listed.entities).map(object);

  const tenantField = node("input", { name: "entityTenant", value: tenant ?? "", placeholder: "Your own Tenant", "aria-label": "Tenant" });
  const tenantForm = node("form", { class: "form" }, node("label", {}, node("span", {}, "Tenant"), tenantField),
    node("div", { class: "actions" }, node("button", { type: "submit" }, "Show")));
  tenantForm.addEventListener("submit", (event) => {
    event.preventDefault();
    context.setSearch({ entityTenant: tenantField.value.trim() || undefined, entity: undefined });
  });

  const list = entities.length
    ? rowsCard(`Entities of type ${type}`, ...entities.map((entity) => dataRow(label(entity.id),
      `${label(entity.pending)} owed · ${label(entity.processed)} processed · ${label(entity.failed)} failed`,
      button("Open", () => context.setSearch({ entity: label(entity.id, "") }), { "aria-label": `Open entity ${label(entity.id, "")}` }))))
    : empty(`No ${type} entities yet`, "Send the first message below; the entity exists from its first message.");

  const idField = node("input", { name: "entityId", value: chosen ?? "", required: "", "aria-label": "Entity id" });
  const tagField = node("input", { name: "tag", value: "message", required: "", "aria-label": "Tag" });
  const keyField = node("input", { name: "primaryKey", placeholder: "Optional: names the message", "aria-label": "Primary key" });
  const payloadField = node("textarea", { name: "payload", rows: "4", "aria-label": "Payload JSON" }, "{}");
  const sendForm = node("form", { class: "form" },
    node("label", {}, node("span", {}, "Entity id"), idField), node("label", {}, node("span", {}, "Tag"), tagField),
    node("label", {}, node("span", {}, "Primary key"), keyField), node("label", {}, node("span", {}, "Payload (JSON object)"), payloadField),
    node("div", { class: "actions" }, node("button", { type: "submit", class: "primary" }, "Send message")));
  sendForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const id = idField.value.trim();
    let payload: unknown;
    try { payload = JSON.parse(payloadField.value || "{}"); } catch { payload = undefined; }
    if (id === "" || payload === undefined || payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      sendForm.querySelector("[role=status]")?.remove();
      sendForm.append(node("p", { role: "status" }, "Give an entity id and a JSON object as the payload."));
      return;
    }
    context.run(request(at(id, "messages"), "POST", {
      tag: tagField.value.trim(), payload, ...(keyField.value.trim() ? { primaryKey: keyField.value.trim() } : {}), ...(tenant === undefined ? {} : { tenantId: tenant }),
    }), () => context.setSearch({ entity: id }));
  });

  const detail = chosen === undefined ? undefined : yield* Effect.gen(function* () {
    const state = object(yield* request(withTenant(at(chosen, "state"))).pipe(Effect.catch(() => Effect.succeed({}))));
    const mailbox = array(object(yield* request(withTenant(at(chosen, "mailbox?limit=50"))).pipe(Effect.catch(() => Effect.succeed({ messages: [] })))).messages).map(object);
    return card(`Entity ${chosen}`,
      node("pre", {}, JSON.stringify(state.state ?? null, null, 2)),
      rowsCard("Owed messages, oldest first", ...(mailbox.length ? mailbox.map((message) => dataRow(label(message.tag),
        `${label(message.messageKey)} · attempts ${label(message.attempts)}${message.lastError ? ` · ${label(message.lastError)}` : ""}${message.deliverAt ? ` · not before ${label(message.deliverAt)}` : ""}`,
        button("Cancel", () => context.run(request(at(chosen, `messages/${encodeURIComponent(label(message.messageKey, ""))}/cancel`), "POST", tenant === undefined ? {} : { tenantId: tenant })),
          { "aria-label": `Cancel message ${label(message.messageKey, "")}` })))
        : [dataRow("Nothing owed", `${label(state.processed, "0")} processed · ${label(state.failed, "0")} failed`)])));
  });

  return node("div", { class: "entity-panel" }, card("Durable entities", tenantForm), list, ...(detail === undefined ? [] : [detail]), card("Send a message", sendForm));
});
