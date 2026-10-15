import { schemaVersions } from "../schema-editor.ts";
import { schemaRecordFields } from "../schema-record.ts";
import { draftJournal, type InspectorDraft } from "./drafts.ts";
import type { ClientOperation, PersistentClient } from "fuzor/server-components/browser";
import type { Values } from "fuzor/server-components/protocol";
import { Cause, Effect, Fiber } from "effect";
import { getRouter } from "fuzor/runtime";
import { request, object } from "../api.ts";
import { button, message, node } from "../dom.ts";
import { gridData, gridLibrary, gridLibraries, parseEdit, changedRecord, cellText, cellValue, type GridAdapter, type GridAdapterOptions, type GridRecord } from "./model.ts";

/** A Fuzor island owns the shared workspace; vendor grids only render and edit cells. */
export function mountPersistent(host: HTMLElement, initialProps: Record<string, unknown>) {
  let props = initialProps;
  const router = getRouter(host.ownerDocument);
  if (!router) throw new Error("The grid needs the dashboard router.");
  let initial = gridData(typeof props.recordsJson === "string" ? JSON.parse(props.recordsJson) : props.records as unknown[]);
  const originals = new Map(initial.records.map(row => [row.id, row]));
  const drafts = new Map<string, GridRecord>();
  const readonly = props.readonly === true;
  let adapter: GridAdapter | undefined;
  let disposed = false, revision = 0, busy = false;
  const lifetime = new AbortController();
  let saveFiber: Fiber.Fiber<unknown, never> | undefined;
  let mountedLibrary = "", renderedFilter = "", renderedSort = "";
  const gridHost = node("div", { class: "database-grid", "aria-label": "Database records" });
  const status = node("div", { "aria-live": "polite" });
  const draftStatus = node("div", { "aria-live": "polite", class: "draft-status" });
  let inspectorDraft: InspectorDraft | undefined;
  let journal: ReturnType<typeof draftJournal> | undefined;
  if (!readonly && typeof props.draftScope === "string") {
    Effect.runSync(Effect.try({ try: () => draftJournal(host.ownerDocument.defaultView!.sessionStorage, { draftScope: props.draftScope, projectId: props.projectId, tenant: props.tenant, collection: props.collection }), catch: cause => cause }).pipe(
      Effect.flatMap(storage => { journal = storage; return storage.read; }),
      Effect.map(saved => { for (const row of saved.records) drafts.set(row.id, row); inspectorDraft = saved.inspector; if (saved.records.length || saved.inspector) draftStatus.replaceChildren(message("Restored this tab's unsaved drafts; saves still check original record versions.")); }),
      Effect.catch(cause => Effect.sync(() => draftStatus.replaceChildren(message(`Draft restoration unavailable: ${String(cause)}`, true))))
    ));
  }
  function retainDrafts() {
    if (!journal) return;
    Effect.runSync(journal.write({ records: [...drafts.values()], ...(inspectorDraft ? { inspector: inspectorDraft } : {}) }).pipe(Effect.tap(() => Effect.sync(() => draftStatus.replaceChildren())), Effect.catch(cause => Effect.sync(() => draftStatus.replaceChildren(message(`Drafts remain in memory, but reload recovery failed: ${String(cause)}`, true))))));
  }
  const inspector = node("section", { class: "record-inspector" });
  const tabs = node("div", { class: "grid-tabs", role: "group", "aria-label": "Grid library" });
  function search(values: Record<string, string | undefined>) {
    const next = new URL(router!.url());
    for (const [key, value] of Object.entries(values)) { if (value === undefined) next.searchParams.delete(key); else next.searchParams.set(key, value); }
    if (next.href !== router!.url()) void router!.navigate(next.pathname + next.search + next.hash).catch(error => status.replaceChildren(message(String(error), true)));
  }
  for (const library of gridLibraries) tabs.append(button(library === "glide" ? "Glide · canvas / React island" : library === "vtable" ? "VTable · canvas" : "Tabulator · DOM", () => search({ grid: library }), { "data-grid": library }));
  const filter = node("input", { type: "search", "aria-label": "Filter loaded records", placeholder: "Filter this page…" });
  const filterForm = node("form", { class: "grid-filter" }, filter, node("button", { type: "submit" }, "Apply filter"));
  filterForm.addEventListener("submit", event => { event.preventDefault(); search({ gridFilter: filter.value || undefined }); });
  const sort = node("select", { "aria-label": "Sort loaded records" }, node("option", { value: "" }, "Server order"));
  for (const column of initial.columns) for (const direction of ["asc", "desc"]) sort.append(node("option", { value: `${column.field}:${direction}` }, `${column.label} ${direction === "asc" ? "↑" : "↓"}`));
  sort.addEventListener("change", () => search({ gridSort: sort.value || undefined }));
  const save = button("Save changes", () => saveChanges());
  const discard = button("Discard changes", () => { drafts.clear(); inspectorDraft = undefined; inspected = undefined; retainDrafts(); draw(true); status.replaceChildren(message("Drafts discarded.")); });
  const count = node("span");
  host.replaceChildren(tabs, node("div", { class: "grid-controls" }, filterForm, sort, count, ...(!readonly ? [save, discard] : [])), node("p", { class: "muted" }, readonly ? "Read-only system records. Filter and sort apply to this loaded page." : 'Double-click a cell to edit JSON: "text", 42, true, null, [] or {}. Edits are staged. Filter and sort apply to this loaded page.'), status, draftStatus, gridHost, inspector);
  function stage(row: GridRecord) {
    if (!Number.isSafeInteger(row.version) || Number(row.version) < 0) throw new Error("A record has no safe version. Refresh before editing.");
    if (!drafts.has(row.id) && drafts.size >= 250) throw new Error("Save or discard the current 250 drafts before staging more records.");
    drafts.set(row.id, row);
  }
  function records() { return initial.records.map(row => drafts.get(row.id) ?? originals.get(row.id)!); }
  let inspected: GridRecord | undefined;
  let inspectedJson = "";
  let inspectedSchemaVersion: number | undefined;
  let fieldEditor: ReturnType<typeof schemaRecordFields> | undefined;
  function inspect() {
    const selected = new URL(router!.url()).searchParams.get("databaseRow");
    const row = records().find(row => row.id === selected);
    const active = schemaVersions(String(props.schemasJson ?? "[]")).find(schema => schema.active);
    const existing = inspector.querySelector<HTMLTextAreaElement>('[aria-label="Selected record JSON"]');
    if (existing) existing.disabled = busy;
    fieldEditor?.setDisabled(busy);
    if (row && inspected?.id === row.id && inspectedSchemaVersion === active?.version && existing) {
      const fresh = JSON.stringify(row.data, null, 2);
      if (existing.value === inspectedJson && inspectorDraft?.id !== row.id) { existing.value = fresh; inspectedJson = fresh; inspected = row; fieldEditor?.sync(); }
      return;
    }
    inspector.replaceChildren(); inspected = row; inspectedSchemaVersion = active?.version; fieldEditor = undefined;
    if (!row) return;
    inspectedJson = JSON.stringify(row.data, null, 2);
    const text = node("textarea", { rows: "9", "aria-label": "Selected record JSON", maxlength: "1048576", ...(readonly ? { readonly: "" } : {}) }, inspectorDraft?.id === row.id ? inspectorDraft.text : inspectedJson);
    text.addEventListener("input", () => {
      const version = inspectorDraft?.id === row.id ? inspectorDraft.version : inspected?.version;
      if (readonly || busy || !Number.isSafeInteger(version)) return;
      inspectorDraft = { id: row.id, version: version!, text: text.value };
      discard.disabled = busy;
      retainDrafts();
    });
    if (active?.fields.length) { fieldEditor = schemaRecordFields(active.fields, text, readonly); inspector.append(fieldEditor.element); }
    text.disabled = busy; fieldEditor?.setDisabled(busy);
    inspector.append(node("h3", {}, `Record ${row.id}`), node("p", { class: "muted" }, `Version ${row.version ?? "unavailable"}`), text);
    if (!readonly) inspector.append(button("Stage record JSON", () => {
      if (busy) return;
      try { const value = parseEdit(text.value); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Record data must be a JSON object."); stage({ ...inspected!, ...(inspectorDraft?.id === row.id ? { version: inspectorDraft.version } : {}), data: value as Record<string, unknown> }); inspectorDraft = undefined; retainDrafts(); draw(true); status.replaceChildren(message("Record staged. Save changes to persist it.")); }
      catch (error) { status.replaceChildren(message(String(error), true)); }
    }));
  }
  function edit(id: string, key: string, text: string) {
    if (readonly || busy) return;
    try { const row = records().find(row => row.id === id)!; stage(changedRecord(row, key, parseEdit(text))); retainDrafts(); status.replaceChildren(message("Cell staged. Save changes to persist it.")); }
    catch (error) { status.replaceChildren(message(String(error), true)); }
    // Re-render outside vendor callbacks, including after invalid edits.
    queueMicrotask(() => { if (!disposed) draw(true); });
  }
  const drawEffect = Effect.fn("new-ui.grid.draw")(function*(force = false) {
    if (disposed) return;
    const params = new URL(router!.url()).searchParams;
    const library = gridLibrary(params.get("grid"));
    const query = params.get("gridFilter") ?? "", order = params.get("gridSort") ?? "";
    filter.value = query; sort.value = order;
    for (const tab of tabs.querySelectorAll("button")) tab.setAttribute("aria-pressed", String(tab.dataset.grid === library));
    save.disabled = busy || drafts.size === 0; discard.disabled = busy || drafts.size === 0 && !inspectorDraft;
    count.textContent = `${initial.records.length} loaded · ${drafts.size} changed`;
    inspect();
    if (!force && library === mountedLibrary && query === renderedFilter && order === renderedSort) return;
    mountedLibrary = library; renderedFilter = query; renderedSort = order;
    const version = ++revision;
    const reusable = adapter && gridHost.dataset.library === library;
    if (!reusable) { adapter?.dispose(); adapter = undefined; gridHost.replaceChildren(message(`Loading ${library}…`)); }
    let data = gridData(records());
    data.records = data.records.filter(row => !query || `${row.id} ${JSON.stringify(row.data)}`.toLowerCase().includes(query.toLowerCase()));
    const [field, direction] = order.split(":");
    const column = data.columns.find(column => column.field === field);
    if (column) data.records.sort((a, b) => {
      const av = cellValue(a, column), bv = cellValue(b, column);
      const compared = typeof av === "number" && typeof bv === "number" ? av - bv : cellText(av).localeCompare(cellText(bv));
      return direction === "desc" ? -compared : compared;
    });
    return yield* Effect.gen(function* () {
      const options = { data, readonly: readonly || busy, selectedId: params.get("databaseRow") ?? undefined, onSelect: (id: string) => search({ databaseRow: id }), onEdit: edit };
      if (reusable && adapter) { yield* Effect.tryPromise({ try: () => Promise.resolve(adapter!.update(options)), catch: cause => cause }); return; }
      const module = yield* Effect.tryPromise<{ mount(host: HTMLElement, options: GridAdapterOptions, signal?: AbortSignal): GridAdapter | Promise<GridAdapter> }, unknown>({ try: () => library === "glide" ? import("./glide.ts") : library === "tabulator" ? import("./tabulator.ts") : import("./vtable.ts"), catch: cause => cause });
      if (disposed || version !== revision) return;
      gridHost.replaceChildren();
      const result = yield* Effect.tryPromise({ try: signal => Promise.resolve(module.mount(gridHost, options, signal)), catch: cause => cause });
      if (disposed || version !== revision) result.dispose(); else { adapter = result; gridHost.dataset.library = library; }
    }).pipe(Effect.catchCause(cause => Effect.sync(() => { if (!disposed && version === revision) { mountedLibrary = ""; gridHost.replaceChildren(message(String(Cause.squash(cause)), true), button("Retry grid", () => { void draw(true); })); } })));
  });
  const draw = (force = false, signal?: AbortSignal) => Effect.runPromise(drawEffect(force), { signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal }).catch(cause => { if (!lifetime.signal.aborted && !signal?.aborted) status.replaceChildren(message(String(cause), true)); });
  function saveChanges() {
    if (readonly || busy || !drafts.size) return;
    busy = true; void draw(true);
    saveFiber = Effect.runFork(Effect.gen(function* () {
      let saved = 0;
      for (const row of [...drafts.values()]) {
        if (!Number.isSafeInteger(row.version)) throw new Error("A record has no safe version. Refresh before editing.");
        const result = yield* request(`${props.apiBase}/database/documents/${encodeURIComponent(String(props.collection))}/${encodeURIComponent(row.id)}`, "PATCH", { tenantId: props.tenant, data: row.data, mode: "replace", expectedVersion: row.version });
        const updated = object(object(result).document ?? result);
        if (typeof updated.version !== "number" || !Number.isSafeInteger(updated.version) || updated.version < 0) throw new Error("Save returned no record version. Refresh before further edits.");
        originals.set(row.id, { ...row, version: updated.version }); drafts.delete(row.id);
        if (inspectorDraft?.id === row.id) {
          if (inspectorDraft.text === JSON.stringify(row.data, null, 2)) inspectorDraft = undefined;
          else inspectorDraft = { ...inspectorDraft, version: updated.version };
        }
        retainDrafts(); saved++;
      }
      if (!disposed) status.replaceChildren(message(`${saved} record${saved === 1 ? "" : "s"} saved.`));
    }).pipe(Effect.catchCause(cause => Effect.sync(() => { const error = Cause.squash(cause); if (!disposed) status.replaceChildren(message(`Save stopped; remaining drafts are retained. ${error instanceof Error ? error.message : String(error)}`, true)); })), Effect.ensuring(Effect.sync(() => { busy = false; if (!disposed) void draw(true); }))));
  }
  const unsubscribe = router.subscribeUrl(() => { void draw(); });
  void draw();
  return {
    update(next: Values, operation?: ClientOperation) {
      const loaded = gridData(typeof next.recordsJson === "string" ? JSON.parse(next.recordsJson) : next.records as unknown as unknown[]);
      const changed = JSON.stringify(initial.records) !== JSON.stringify(loaded.records);
      const loadedIds = new Set(loaded.records.map(row => row.id));
      for (const id of originals.keys()) if (!loadedIds.has(id) && !drafts.has(id) && inspectorDraft?.id !== id) originals.delete(id);
      for (const row of loaded.records) if (!drafts.has(row.id)) originals.set(row.id, row);
      initial = loaded; props = next;
      if (changed && drafts.size) status.replaceChildren(message("Server records refreshed; local drafts keep their original versions for conflict checking."));
      return draw(changed, operation?.signal);
    },
    dispose() { disposed = true; lifetime.abort(); revision++; unsubscribe(); adapter?.dispose(); if (saveFiber) Effect.runFork(Fiber.interrupt(saveFiber)); },
  };
}
export function mount(host: HTMLElement, props: Record<string, unknown>) {
  const client = mountPersistent(host, props);
  return () => client.dispose();
}
