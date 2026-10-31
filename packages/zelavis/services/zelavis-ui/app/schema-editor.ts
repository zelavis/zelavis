import { draftJournal } from "./grids/drafts.ts";
import { Effect, Schema } from "effect";
import { CollectionFieldEntrySchema, StoredCollectionSchemaCodec, type CollectionFieldEntry, type StoredCollectionSchema } from "zelavis/db/schema";
import { ApiError, request } from "./api.ts";
import { button, field, message, node } from "./dom.ts";
import { dropdown, setDropdownOptions, type DropdownElement } from "./dropdown.ts";
import { nextSchemaVersion, parseSchemaFields, schemaVersions } from "./schema-model.ts";

export { nextSchemaVersion, parseSchemaFields, schemaVersions };

export function mountSchemaEditor(host: HTMLElement, options: { api: string; tenant: string; collection: string; schemasJson: string; selectedVersion?: string; draftScope?: unknown; projectId?: unknown; run(effect: Effect.Effect<unknown, unknown>): void; select(version: string): void }) {
  let schemas = schemaVersions(options.schemasJson);
  let draftVersion: number | undefined;
  const selected = () => schemas.find(schema => schema.version === draftVersion) ?? schemas.find(schema => String(schema.version) === options.selectedVersion) ?? schemas.find(schema => schema.active) ?? schemas.at(-1);
  let draft = JSON.stringify(selected()?.fields ?? [], null, 2);
  let dirty = false, busy = false;
  const status = node("div", { "aria-live": "polite" });
  const journalStatus = node("div", { "aria-live": "polite" });
  let journal: ReturnType<typeof draftJournal> | undefined;
  if (options.draftScope) Effect.runSync(Effect.try({ try: () => draftJournal(host.ownerDocument.defaultView!.sessionStorage, { draftScope: options.draftScope, projectId: options.projectId, tenant: options.tenant, collection: options.collection, kind: "schema" }), catch: cause => cause }).pipe(Effect.flatMap(value => { journal = value; return value.read; }), Effect.tap(saved => Effect.sync(() => {
    if (saved.inspector) { draft = saved.inspector.text; draftVersion = saved.inspector.version || undefined; dirty = true; journalStatus.replaceChildren(message(`Restored unsaved schema draft based on v${saved.inspector.version}.`)); }
  })), Effect.catch(cause => Effect.sync(() => journalStatus.replaceChildren(message(`Schema draft recovery unavailable: ${String(cause)}`, true))))));
  function retain() {
    if (!journal) return;
    Effect.runSync(journal.write({ records: [], ...(dirty ? { inspector: { id: "schema", version: draftVersion ?? selected()?.version ?? 0, text: draft } } : {}) }).pipe(Effect.catch(cause => Effect.sync(() => journalStatus.replaceChildren(message(`Schema draft remains in memory; reload recovery failed: ${String(cause)}`, true))))));
  }
  const versions = dropdown({ label: "Schema version" }, []);
  const text = node("textarea", { rows: "16", maxlength: "1048576", "aria-label": "Schema fields JSON" }, draft);
  const list = node("ol", { class: "schema-fields" });
  const base = `${options.api}/database/schemas/${encodeURIComponent(options.collection)}`;
  /** What the last activation declared and skipped: kept across the refresh that follows it. */
  let report = "";
  const describeActivation = (body: unknown) => {
    const activation = (body as { activation?: { applied: { analyzer?: { fields: string[] }; measures: { name: string }[]; edges: { name: string }[]; spatial?: { fields: string[] }; embedding?: { field: string } }; skipped: { path: string; reason: string }[]; documents: number } | null })?.activation;
    if (!activation) return "Activated. The collection does not exist yet; its declarations apply when it is created.";
    const { applied } = activation;
    const declared = [
      ...(applied.analyzer ? [`search on ${applied.analyzer.fields.join(", ")}`] : []),
      ...applied.measures.map(measure => `measure ${measure.name}`),
      ...applied.edges.map(edge => `edge ${edge.name}`),
      ...(applied.spatial ? [`geometry on ${applied.spatial.fields.join(", ")}`] : []),
      ...(applied.embedding ? [`similarity on ${applied.embedding.field}`] : []),
    ];
    const skipped = activation.skipped.map(entry => `${entry.path} (${entry.reason})`);
    return `Activated; ${activation.documents} records re-indexed. Declared: ${declared.join("; ") || "nothing"}.${skipped.length ? ` Skipped: ${skipped.join("; ")}.` : ""}`;
  };
  function redraw() {
    status.replaceChildren(...(report ? [message(report)] : []));
    activate.disabled = busy || selected()?.active === true || !selected();
    if (!dirty) save.disabled = busy;
    setDropdownOptions(versions, schemas.map(schema => ({ value: String(schema.version), label: `v${schema.version}${schema.active ? " · active" : ""}` })), selected() ? String(selected()!.version) : undefined);
    list.replaceChildren();
    try {
      const entries = parseSchemaFields(text.value);
      for (const [index, entry] of entries.entries()) list.append(node("li", {}, node("span", {}, `${entry.field.label || entry.name} · ${entry.name} · ${entry.field._tag}${entry.field.required ? " · required" : ""}`), button("Move up", () => { const next = [...entries]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; setFields(next); }, { ...(index === 0 ? { disabled: "" } : {}), "aria-label": `Move ${entry.name} up` }), button("Remove", () => { if (window.confirm(`Remove field ${entry.name} from this draft? Existing records are retained.`)) setFields(entries.filter((_, at) => at !== index)); }, { "aria-label": `Remove field ${entry.name}` })));
    } catch (cause) { status.replaceChildren(message(String(cause), true)); }
  }
  function setFields(fields: readonly CollectionFieldEntry[]) { text.value = JSON.stringify(fields, null, 2); draft = text.value; dirty = true; draftVersion ??= selected()?.version; retain(); redraw(); }
  text.addEventListener("input", () => { draft = text.value; dirty = true; draftVersion ??= selected()?.version; retain(); redraw(); });
  versions.addEventListener("change", () => { if (dirty && !window.confirm("Discard this unsaved schema draft and switch versions?")) { redraw(); return; } dirty = false; draftVersion = undefined; retain(); options.select(versions.value); });
  const kinds = ["TextField", "LongTextField", "RichTextField", "NumberField", "IntegerField", "BooleanField", "DateTimeField", "SelectField", "MultiSelectField", "ReferenceField", "RepeaterField", "JsonField", "SlugField", "UrlField", "FileField", "ImageField", "AudioField", "VideoField", "GeometryField", "VectorField"];
  const kind = dropdown({ name: "kind", label: "Field type" }, kinds.map(tag => ({ value: tag, label: tag.replace(/Field$/, "") })));
  const builder = node("form", { class: "form" }, field("name", "Field name"), field("label", "Field label", "text", "", false), kind, node("label", {}, node("input", { type: "checkbox", name: "required" }), "Required"), field("options", "Select options (comma separated)", "text", "", false), field("collection", "Related collection", "text", "", false), field("resolution", "Geometry resolution (0–15)", "number", "", false), field("model", "Vector model", "text", "", false), field("modelVersion", "Vector model version", "text", "", false), field("dimension", "Vector dimension", "number", "", false), field("metric", "Vector metric (cosine, dot or euclidean)", "text", "", false), node("button", { type: "submit" }, "Add field"));
  builder.addEventListener("submit", event => {
    event.preventDefault();
    if (busy) return;
    try {
      const data = new FormData(builder), tag = String(data.get("kind"));
      const entry = { name: String(data.get("name")).trim(), field: { _tag: tag, label: String(data.get("label") ?? ""), required: data.has("required"), ...(["SelectField", "MultiSelectField"].includes(tag) ? { options: String(data.get("options") ?? "").split(",").map(value => value.trim()).filter(Boolean) } : {}), ...(tag === "ReferenceField" ? { collection: String(data.get("collection") ?? "") } : {}), ...(tag === "RepeaterField" ? { fields: [] } : {}), ...(tag === "GeometryField" ? { coordinates: "wgs84", resolution: Number(data.get("resolution") || 9) } : {}), ...(tag === "VectorField" ? { model: String(data.get("model") ?? "").trim(), modelVersion: String(data.get("modelVersion") ?? "").trim(), dimension: Number(data.get("dimension")), metric: String(data.get("metric") || "cosine").trim() } : {}) } };
      setFields(parseSchemaFields(JSON.stringify([...parseSchemaFields(text.value), entry])));
      status.replaceChildren(message("Field added to draft. Save a new version to apply it."));
    } catch (cause) { status.replaceChildren(message(String(cause), true)); }
  });
  const submit = (work: Effect.Effect<unknown, unknown>) => {
    if (busy) return;
    busy = true;
    const buttons = [...host.querySelectorAll<HTMLButtonElement | HTMLInputElement | DropdownElement | HTMLTextAreaElement>("button:not(:disabled), input:not(:disabled), zv-select:not([disabled]), textarea:not(:disabled)")];
    buttons.forEach(button => { button.disabled = true; });
    options.run(work.pipe(Effect.ensuring(Effect.sync(() => { busy = false; buttons.forEach(button => { button.disabled = false; }); }))));
  };
  const save = button("Save and activate new schema version", () => submit(Effect.gen(function*() {
    const fields = yield* Effect.try({ try: () => parseSchemaFields(text.value), catch: cause => new ApiError({ message: String(cause) }) });
    const version = nextSchemaVersion(schemas);
    report = describeActivation(yield* request(base, "POST", { tenantId: options.tenant, version, activate: true, fields }));
    dirty = false; draftVersion = undefined; retain();
  })));
  const activate = button("Activate selected schema", () => { const schema = selected(); if (schema && window.confirm(`Activate schema v${schema.version} for future writes? Existing records are retained.`)) submit(Effect.map(request(`${base}/activate`, "POST", { tenantId: options.tenant, version: schema.version }), body => { report = describeActivation(body); })); }, selected()?.active || !selected() ? { disabled: "" } : {});
  host.replaceChildren(node("h2", {}, "Collection schema"), message("Schema versions govern future writes. Existing records are retained. Raw JSON supports all field metadata and nested definitions."), versions, activate, list, builder, node("label", {}, "Fields JSON", text), save, button("Discard schema draft", () => { if (!window.confirm("Discard this unsaved schema draft?")) return; dirty = false; draftVersion = undefined; draft = JSON.stringify(selected()?.fields ?? [], null, 2); text.value = draft; retain(); redraw(); }), status, journalStatus);
  redraw();
  return {
    update(next: { schemasJson: string; selectedVersion?: string }) {
      const changed = next.selectedVersion !== options.selectedVersion;
      options.selectedVersion = next.selectedVersion;
      schemas = schemaVersions(next.schemasJson);
      if (!dirty || changed) { dirty = false; draftVersion = undefined; draft = JSON.stringify(selected()?.fields ?? [], null, 2); text.value = draft; }
      redraw();
    },
    dispose() { host.replaceChildren(); }
  };
}
