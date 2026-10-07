import { getRouter } from "fuzor/runtime";
import type { PersistentClient, PersistentClientModule } from "fuzor/server-components/browser";
import type { Values } from "fuzor/server-components/protocol";
import { mountPersistent as mountGrid } from "../grids/controller.ts";
import { Effect } from "effect";
import { request } from "../api.ts";
import { parseEdit } from "../grids/model.ts";
import { button, field, link, message, node } from "../dom.ts";
import { object } from "../api.ts";

export default {
  mountPersistent(host, initial): PersistentClient {
    const router = getRouter(host.ownerDocument);
    if (!router) throw new Error("Database workspace needs the dashboard router");
    if (initial.error) { if (initial.signin) host.dataset.requiresLogin = "true"; host.replaceChildren(link("Sign in", "/login"), link("Projects", "/")); return { update() {}, dispose() {} }; }
    let props = initial;
    const tenant = field("tenantId", "Tenant ID", "text", String(props.tenant));
    const collection = field("collection", "Collection / table", "text", String(props.collection));
    const selector = node("form", { class: "filters" }, tenant, collection, node("button", { type: "submit" }, "Open records"));
    const choices = node("div", { class: "workspace-links" });
    const gridHost = node("div", { class: "persistent-grid" });
    const paging = node("div", { class: "grid-controls" });
    const errors = node("div", { "aria-live": "polite" });
    const actions = node("div");
    host.replaceChildren(selector, choices, paging, errors, gridHost, actions);
    let grid: PersistentClient | undefined;
    const search = (values: Record<string, string | undefined>) => {
      const url = new URL(router.url());
      for (const [key, value] of Object.entries(values)) { if (value === undefined) url.searchParams.delete(key); else url.searchParams.set(key, value); }
      void router.navigate(url.href, { focus: "preserve", scroll: "preserve" }).catch(error => errors.replaceChildren(message(String(error), true)));
    };
    selector.addEventListener("submit", event => { event.preventDefault(); const data = new FormData(selector); search({ databaseTenant: String(data.get("tenantId") ?? ""), databaseTable: String(data.get("collection") ?? ""), databaseSystemView: undefined, databaseOffset: undefined, databaseRow: undefined }); });
    let disposed = false;
    const lifetime = new AbortController();
    function form(fields: HTMLElement[], title: string, submit: (data: FormData) => Promise<unknown>) {
      const control = node("button", { type: "submit" }, title);
      const form = node("form", { class: "form" }, ...fields, control);
      form.addEventListener("submit", async event => {
        event.preventDefault(); if (control.disabled) return; control.disabled = true;
        let error: unknown;
        try { await submit(new FormData(form)); }
        catch (cause) { error = cause; }
        finally {
          if (!disposed) {
            // Even failed mutations revalidate authoritative lifecycle state.
            await router!.navigate(router!.url(), { focus: "preserve", scroll: "preserve" });
            control.disabled = false;
            errors.replaceChildren(message(error ? String(error) : "Saved.", Boolean(error)));
          }
        }
      });
      return node("details", {}, node("summary", {}, title), form);
    }
    if (props.tenant && props.collection && !props.readonly) actions.append(form([
      field("recordId", "Record ID (optional)", "text", "", false),
      node("label", {}, node("span", {}, "Record data (JSON object)"), node("textarea", { name: "data", required: "", rows: "8", maxlength: "1048576" }, "{}")),
    ], "Add record", data => {
      const record = parseEdit(String(data.get("data")));
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Record data must be a JSON object.");
      const id = String(data.get("recordId") ?? "");
      return Effect.runPromise(request(`${props.apiBase}/database/documents/${encodeURIComponent(String(props.collection))}`, "POST", { tenantId: props.tenant, data: record, ...(id ? { id } : {}) }), { signal: lifetime.signal });
    }));
    const content = new URL(router.url()).pathname.includes("/content");
    actions.append(form([field("tenantId", "Tenant ID", "text", String(props.tenant)), field("name", content ? "Collection name" : "Table name")], content ? "Create content collection" : "Create table", data => Effect.runPromise(request(`${props.apiBase}/database/documents/collections`, "POST", { tenantId: String(data.get("tenantId")), name: String(data.get("name")), surface: content ? "content-studio" : "database" }), { signal: lifetime.signal })));
    function controls() {
      host.dataset.projectContext = String(props.navigationJson);
      const navigation = JSON.parse(String(props.navigationJson));
      choices.replaceChildren();
      for (const raw of JSON.parse(String(props.choicesJson))) {
        const item = object(raw); const params = new URLSearchParams();
        for (const [key, value] of Object.entries(object(item.search))) if (typeof value === "string") params.set(key, value);
        choices.append(link(String(item.title ?? "Table"), `/projects/${encodeURIComponent(String(props.projectId))}/${content ? "content" : "database"}?${params}`));
      }
      paging.replaceChildren();
      if (props.tenant && props.collection && !props.readonly) {
        const previous = button("Previous page", () => search({ databaseOffset: String(Math.max(0, Number(props.offset) - Number(props.limit))), databaseRow: undefined })); previous.disabled = Number(props.offset) === 0;
        const next = button("Next page", () => search({ databaseOffset: String(Number(props.offset) + Number(props.limit)), databaseRow: undefined })); next.disabled = JSON.parse(String(props.recordsJson)).length < Number(props.limit);
        paging.append(previous, next);
        const size = node("select", { "aria-label": "Records per page" });
        for (const count of [...new Set([25, 100, 250, Number(props.limit)])]) { const option = node("option", { value: String(count) }, String(count)); option.selected = count === Number(props.limit); size.append(option); }
        size.addEventListener("change", () => search({ databaseLimit: size.value, databaseOffset: undefined, databaseRow: undefined }));
        paging.append(node("label", {}, "Page size ", size));
      }
    }
    const hasRecords = () => Boolean(props.tenant && (props.collection || props.systemView));
    controls();
    if (hasRecords()) grid = mountGrid(gridHost, props);
    else gridHost.append(message("Choose a tenant and table to open records."));
    return {
      async update(next: Values) { props = next; controls(); if (grid) await grid.update(props); },
      dispose() { disposed = true; lifetime.abort(); return grid?.dispose(); },
    };
  },
} satisfies PersistentClientModule;
