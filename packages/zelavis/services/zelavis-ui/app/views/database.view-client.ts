import { mountSchemaEditor } from "../schema-editor.ts";
import { getRouter } from "fuzor/runtime";
import type { PersistentClient, PersistentClientModule } from "fuzor/server-components/browser";
import type { Values } from "fuzor/server-components/protocol";
import { mountPersistent as mountGrid } from "../grids/controller.ts";
import { Effect, Cause } from "effect";
import { request } from "../api.ts";
import { parseEdit } from "../grids/model.ts";
import { button, field, link, message, node } from "../dom.ts";
import { object } from "../api.ts";
import { stripMount } from "../mount.ts";
import { mountCreateTable } from "../create-table-dialog.ts";

export default {
  mountPersistent(host, initial): PersistentClient {
    const router = getRouter(host.ownerDocument);
    if (!router) throw new Error("Database workspace needs the dashboard router");
    if (initial.error) { if (initial.signin) host.dataset.requiresLogin = "true"; host.replaceChildren(link("Sign in", "/login"), link("Projects", "/")); return { update() {}, dispose() {} }; }
    let props = initial;
    const tenantList = () => { const tenants: unknown = JSON.parse(String(props.tenantsJson ?? "[]")); return Array.isArray(tenants) ? tenants.filter((value): value is string => typeof value === "string") : []; };
    const tenantsWithTables = () => new Set(JSON.parse(String(props.choicesJson ?? "[]")).map((item: unknown) => object(object(item).search)).filter((search: Record<string, unknown>) => typeof search.databaseTable === "string").map((search: Record<string, unknown>) => search.databaseTenant));
    const tenant = node("label", {}, node("span", {}, "Tenant"), node("select", { name: "tenantId", "aria-label": "Tenant" }));
    function tenants() {
      const select = tenant.querySelector("select")!; const withTables = tenantsWithTables();
      const names = [...new Set([...tenantList(), String(props.tenant)].filter(Boolean))];
      select.replaceChildren(...names.map(name => { const option = node("option", { value: name }, withTables.has(name) ? name : `${name} (no tables)`); option.selected = name === String(props.tenant); return option; }));
    }
    const collection = field("collection", "Collection / table", "text", String(props.collection));
    const selector = node("form", { class: "filters" }, tenant, collection, node("button", { type: "submit" }, "Open records"));
    const gridHost = node("div", { class: "persistent-grid" });
    const trail: string[] = []; let trailKey = "";
    const paging = node("div", { class: "grid-controls" });
    const errors = node("div", { "aria-live": "polite" });
    const actions = node("div");
    host.replaceChildren(selector, paging, errors, gridHost, actions);
    let grid: PersistentClient | undefined;
    const search = (values: Record<string, string | undefined>) => {
      const url = new URL(router.url());
      for (const [key, value] of Object.entries(values)) { if (value === undefined) url.searchParams.delete(key); else url.searchParams.set(key, value); }
      void router.navigate(url.href, { focus: "preserve", scroll: "preserve" }).catch(error => errors.replaceChildren(message(String(error), true)));
    };
    // Choosing a Tenant applies at once: a system view stays open for the new Tenant; a table does not carry over, since the other Tenant has its own.
    tenant.querySelector("select")!.addEventListener("change", event => {
      const name = (event.currentTarget as HTMLSelectElement).value;
      search({ databaseTenant: name, ...(props.systemView ? {} : { databaseTable: undefined }), databaseRow: undefined, databaseAfter: undefined, databaseWhere: undefined, databaseSort: undefined, databaseHide: undefined });
    });
    selector.addEventListener("submit", event => { event.preventDefault(); const data = new FormData(selector); search({ databaseTenant: String(data.get("tenantId") ?? ""), databaseTable: String(data.get("collection") ?? ""), databaseSystemView: undefined, databaseAfter: undefined, databaseRow: undefined }); });
    let disposed = false;
    const lifetime = new AbortController();
    function form(fields: HTMLElement[], title: string, submit: (data: FormData) => Effect.Effect<unknown, unknown>) {
      const control = node("button", { type: "submit" }, title);
      const form = node("form", { class: "form" }, ...fields, control);
      form.addEventListener("submit", event => {
        event.preventDefault(); if (control.disabled) return; control.disabled = true;
        let failure: unknown;
        Effect.runFork(Effect.gen(function* () {
          yield* Effect.suspend(() => submit(new FormData(form))).pipe(Effect.catchCause(cause => Effect.sync(() => { failure = Cause.squash(cause); })));
          if (!disposed) yield* Effect.tryPromise({ try: () => router!.navigate(router!.url(), { focus: "preserve", scroll: "preserve" }), catch: cause => cause });
          if (!disposed) errors.replaceChildren(message(failure ? String(failure) : "Saved.", Boolean(failure)));
        }).pipe(Effect.catchCause(cause => Effect.sync(() => { if (!disposed) errors.replaceChildren(message(String(Cause.squash(cause)), true)); })), Effect.ensuring(Effect.sync(() => { control.disabled = false; }))), { signal: lifetime.signal });
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
      return request(`${props.apiBase}/database/documents/${encodeURIComponent(String(props.collection))}`, "POST", { tenantId: props.tenant, data: record, ...(id ? { id } : {}) });
    }));
    const content = new URL(router.url()).pathname.includes("/content");
    // Creating a table is a dialog the sidebar's Create Table opens through URL state; Content has its own Add Content Type page.
    const createDialog = content ? undefined : mountCreateTable(host, {
      api: String(props.apiBase), tenants: tenantList(), tenant: String(props.tenant),
      created: (chosen, table) => search({ databaseTenant: chosen, databaseTable: table, databaseSystemView: undefined, databaseDialog: undefined, databaseRow: undefined, databaseAfter: undefined, databaseWhere: undefined, databaseSort: undefined, databaseHide: undefined }),
      dismissed: () => search({ databaseDialog: undefined }),
    });
    function controls() {
      host.dataset.projectContext = String(props.navigationJson);
      const navigation = JSON.parse(String(props.navigationJson));
      tenants();
      createDialog?.sync(new URL(router!.url()).searchParams.get("databaseDialog") === "create-table", tenantList(), String(props.tenant));
      const here = new URL(router!.url()).searchParams;
      const key = JSON.stringify([props.tenant, props.collection, props.limit, here.get("databaseWhere"), here.get("databaseSort")]);
      if (key !== trailKey) { trailKey = key; trail.length = 0; }
      paging.replaceChildren();
      if (props.tenant && props.collection && !props.readonly) {
        const after = String(props.after ?? ""), following = String(props.next ?? "");
        // The database continues from an opaque cursor, so a page can only go on; the way back is the cursors already visited in this tab.
        const first = button("First page", () => { trail.length = 0; search({ databaseAfter: undefined, databaseRow: undefined }); }); first.disabled = after === "";
        const previous = button("Previous page", () => { const back = trail.pop() ?? ""; search({ databaseAfter: back || undefined, databaseRow: undefined }); }); previous.disabled = trail.length === 0;
        const next = button("Next page", () => { trail.push(after); search({ databaseAfter: following, databaseRow: undefined }); }); next.disabled = following === "";
        paging.append(first, previous, next);
        const size = node("select", { "aria-label": "Records per page" });
        for (const count of [...new Set([25, 100, 250, Number(props.limit)])]) { const option = node("option", { value: String(count) }, String(count)); option.selected = count === Number(props.limit); size.append(option); }
        size.addEventListener("change", () => search({ databaseLimit: size.value, databaseAfter: undefined, databaseRow: undefined }));
        paging.append(node("label", {}, "Page size ", size));
      }
    }
    let schemaEditor: ReturnType<typeof mountSchemaEditor> | undefined;
    if (props.tenant && props.collection && !props.readonly) {
      const records = button("Records", () => search({ databasePanel: undefined, schemaVersion: undefined }));
      const schema = button("Collection schema", () => search({ databasePanel: "schema" }));
      selector.append(records, schema);
    }
    if (props.schemaPanel) {
      actions.hidden = true; paging.hidden = true;
      schemaEditor = mountSchemaEditor(gridHost, { api: String(props.apiBase), tenant: String(props.tenant), collection: String(props.collection), schemasJson: String(props.schemasJson ?? "[]"), selectedVersion: String(props.selectedSchemaVersion ?? ""), draftScope: props.draftScope, projectId: props.projectId, select: version => search({ schemaVersion: version }), run: work => {
        Effect.runFork(Effect.gen(function*() {
          const result = yield* Effect.exit(work);
          if (disposed) return;
          yield* Effect.tryPromise({ try: () => router!.navigate(router!.url(), { focus: "preserve", scroll: "preserve" }), catch: cause => cause });
          if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
        }).pipe(Effect.catchCause(cause => Effect.sync(() => { if (!disposed) errors.replaceChildren(message(String(Cause.squash(cause)), true)); }))), { signal: lifetime.signal });
      } });
    }
    const hasRecords = () => Boolean(props.tenant && (props.collection || props.systemView));
    controls();
    if (!props.schemaPanel && hasRecords()) grid = mountGrid(gridHost, props);
    else if (!props.schemaPanel) gridHost.append(message(props.tenant && !tenantsWithTables().has(props.tenant) ? `Tenant ${String(props.tenant)} has no tables. It stays listed because it still holds its history; create a table to use it again.` : "Choose a tenant and table to open records."));
    return {
      update(next: Values, operation) { props = next; controls(); schemaEditor?.update({ schemasJson: String(props.schemasJson ?? "[]"), selectedVersion: String(props.selectedSchemaVersion ?? "") }); return grid?.update(props, operation); },
      dispose() { disposed = true; lifetime.abort(); createDialog?.dispose(); schemaEditor?.dispose(); return grid?.dispose(); },
    };
  },
} satisfies PersistentClientModule;
