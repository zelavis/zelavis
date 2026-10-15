import { Effect, Fiber } from "effect";
import type { CollectionFieldEntry } from "zelavis/db/schema";
import { ApiError, array, label, object, request } from "./api.ts";
import {
  contentBuilderInputToEntry, contentFieldEntryToBuilderInput, createPreviewFieldValue, getContentSchemaFields, getContentSchemaUi, insertCollectionField, isRichTextSchemaField, moveCollectionField,
  parseCollectionFieldEntriesJson, removeCollectionField, updateCollectionField, validateCollectionFieldName, type ContentFieldBuilderInput, type ContentFieldBuilderKind, type ContentSchemaDefinition
} from "./content-schema.ts";
import { button, node } from "./dom.ts";
import { fieldEditor } from "./field-editors.ts";
import { resourceNotice } from "./page-kit.ts";

/**
 * The content type builder island: fields, raw type editor, and type settings. It owns the draft schema and the field
 * being built; every change that alters what is shown re-renders, and typing into a form field does not, so focus stays.
 */

export const FIELD_TYPES: readonly { value: ContentFieldBuilderKind; label: string; description: string }[] = [
  { value: "text", label: "Short Text", description: "Single-line text input." },
  { value: "long-text", label: "Long Text", description: "Multi-line plain text." },
  { value: "rich-text", label: "Rich Text", description: "Lexical editor stored as HTML." },
  { value: "number", label: "Number", description: "Decimal number." },
  { value: "integer", label: "Integer", description: "Whole number." },
  { value: "boolean", label: "Boolean", description: "True or false switch." },
  { value: "datetime", label: "Date & Time", description: "ISO date-time string." },
  { value: "select", label: "Select", description: "Single choice from options." },
  { value: "multi-select", label: "Multi Select", description: "Multiple choices from options." },
  { value: "status", label: "Status", description: "Draft, review, published, archived." },
  { value: "relation", label: "Reference", description: "Link to another collection item." },
  { value: "repeater", label: "Repeater", description: "Repeatable group of fields." },
  { value: "image", label: "Image", description: "Image file reference." },
  { value: "document", label: "Document", description: "PDF, text, JSON, or zip reference." },
  { value: "audio", label: "Audio", description: "Audio file reference." },
  { value: "video", label: "Video", description: "Video file reference." },
  { value: "file", label: "File", description: "Generic file reference." },
  { value: "json", label: "JSON", description: "Arbitrary structured value." },
  { value: "slug", label: "Slug", description: "URL-safe identifier." },
  { value: "url", label: "URL", description: "Web address." }
];

const DEFAULT_INPUT: ContentFieldBuilderInput = { name: "", label: "", description: "", kind: "text", required: false, group: "Content", placeholder: "", helpText: "", rows: 5, options: [], relationCollection: "", relationMultiple: false };
const STATUS_OPTIONS = "draft\nreview\npublished\narchived";
const FILE_KINDS = new Set<ContentFieldBuilderKind>(["image", "document", "audio", "video", "file"]);

export function slugifyFieldName(text: string) {
  return text.trim().replace(/[^a-zA-Z0-9]+/g, " ").split(" ").filter(Boolean).map((word, index) => { const lower = word.toLowerCase(); return index === 0 ? lower : `${lower[0]?.toUpperCase() ?? ""}${lower.slice(1)}`; }).join("");
}

export function validateBuilderInput(input: ContentFieldBuilderInput): string | undefined {
  const nameIssue = validateCollectionFieldName(input.name);
  if (nameIssue) return nameIssue;
  if ((input.kind === "select" || input.kind === "multi-select" || input.kind === "status") && (!input.options || input.options.length === 0)) return "Select fields need at least one option.";
  if (input.kind === "relation" && !input.relationCollection?.trim()) return "Reference fields need a related collection.";
  if (input.kind === "repeater") {
    const names = new Set<string>();
    for (const nested of input.nestedFields ?? []) {
      const issue = validateCollectionFieldName(nested.name);
      if (issue) return `Nested field "${nested.name || "unnamed"}": ${issue}`;
      if (names.has(nested.name)) return `Duplicate nested field name "${nested.name}".`;
      names.add(nested.name);
    }
  }
  if (input.min !== undefined && input.max !== undefined && input.min > input.max) return "Minimum value cannot be greater than maximum value.";
  if (input.minLength !== undefined && input.maxLength !== undefined && input.minLength > input.maxLength) return "Minimum length cannot be greater than maximum length.";
  if (input.minItems !== undefined && input.maxItems !== undefined && input.minItems > input.maxItems) return "Minimum items cannot be greater than maximum items.";
  return undefined;
}

export function fieldTypeName(definition: ContentSchemaDefinition) {
  const ui = getContentSchemaUi(definition);
  if (ui?.control === "select" || ui?.control === "multi-select" || ui?.control === "reference" || ui?.control === "slug" || ui?.control === "url" || ui?.control === "json") return ui.control;
  if (definition.type === "file" && Array.isArray(definition.mimeTypes)) {
    const mimes = definition.mimeTypes as string[];
    if (mimes.some(value => value.startsWith("image/"))) return "image";
    if (mimes.some(value => value.startsWith("audio/"))) return "audio";
    if (mimes.some(value => value.startsWith("video/"))) return "video";
    if (mimes.some(value => value.includes("pdf"))) return "document";
    return "file";
  }
  if (isRichTextSchemaField("_content", definition)) return "rich text";
  return typeof definition.type === "string" ? definition.type : "custom";
}

function editorName(definition: ContentSchemaDefinition) {
  const ui = getContentSchemaUi(definition);
  if (isRichTextSchemaField("_content", definition)) return "Lexical rich text";
  const named: Record<string, string> = { textarea: "Textarea", select: "Select", "multi-select": "Multi-select", reference: "Reference picker", datetime: "Date-time input", json: "JSON editor" };
  if (ui?.control && named[ui.control]) return named[ui.control];
  return definition.type === "boolean" ? "Switch" : "Input";
}

interface Stored { version: number; active: boolean; fields: CollectionFieldEntry[] }

export function mount(host: HTMLElement, props: Record<string, unknown>) {
  const api = String(props.api);
  const tenant = String(props.tenant);
  const type = String(props.contentType);
  const base = String(props.studioBase);
  const params = new URL(location.href).searchParams;
  const state = {
    view: ["fields", "editor", "settings"].includes(params.get("view") ?? "") ? params.get("view")! : "fields",
    schemas: [] as Stored[], draft: undefined as CollectionFieldEntry[] | undefined, json: "", selected: "" as string,
    mode: "create" as "create" | "edit", input: { ...DEFAULT_INPUT } as ContentFieldBuilderInput, optionsText: "", message: "", error: "", saving: false, removal: "",
    preview: {} as Record<string, unknown>, labels: object(props.preferences).labels ? { ...object(object(props.preferences).labels) } as Record<string, string> : {} as Record<string, string>,
    pinned: array(object(props.preferences).pinnedTypes).map(String), documentCount: Number(props.documentCount) || 0
  };
  const fibers = new Set<Fiber.Fiber<unknown, never>>();
  const active = () => state.schemas.find(schema => schema.active) ?? state.schemas.at(-1);

  function adopt(schemas: Stored[]) {
    state.schemas = schemas;
    const current = active();
    state.draft = current ? [...current.fields] : undefined;
    state.json = JSON.stringify(state.draft ?? [], null, 2);
    if (!state.draft?.some(entry => entry.name === state.selected)) state.selected = state.draft?.[0]?.name ?? "";
  }
  const decode = (raw: unknown): Stored[] => array(object(raw).schemas).map(object).map(entry => ({ version: Number(entry.version), active: entry.active === true, fields: array(entry.fields) as CollectionFieldEntry[] }));
  adopt(decode({ schemas: JSON.parse(String(props.schemasJson ?? "[]")) }));

  const fork = (work: Effect.Effect<unknown, ApiError>, done: () => void) => {
    state.saving = true; state.message = ""; state.error = ""; render();
    const fiber = Effect.runFork(work.pipe(Effect.tap(() => Effect.sync(done)), Effect.catch(error => Effect.sync(() => { state.error = error.message; })), Effect.ensuring(Effect.sync(() => { state.saving = false; render(); }))));
    fibers.add(fiber); fiber.addObserver(() => fibers.delete(fiber));
  };
  const reload = Effect.gen(function*() { adopt(decode(yield* request(`${api}/database/schemas/${encodeURIComponent(type)}?tenantId=${encodeURIComponent(tenant)}`))); });
  const saveSchema = (fields: CollectionFieldEntry[], version: number) => request(`${api}/database/schemas/${encodeURIComponent(type)}`, "POST", { tenantId: tenant, version, activate: true, fields }).pipe(Effect.flatMap(() => reload));
  const savePreferences = (labels: Record<string, string>, pinned: string[]) => request(`${api}/runtime/settings`, "PATCH", { preferences: { content: { labels, pinnedTypes: pinned } } });
  const syncUrl = () => { const url = new URL(location.href); if (state.view === "fields") url.searchParams.delete("view"); else url.searchParams.set("view", state.view); history.replaceState(history.state, "", url); };

  function startCreate(kind: ContentFieldBuilderKind = "text") { state.mode = "create"; state.input = { ...DEFAULT_INPUT, kind }; state.optionsText = kind === "status" ? STATUS_OPTIONS : ""; }
  function startEdit(entry: CollectionFieldEntry) { state.mode = "edit"; state.input = contentFieldEntryToBuilderInput(entry); state.optionsText = (state.input.options ?? []).join("\n"); }
  const say = (text: string) => { state.message = text; state.error = ""; render(); };
  const fail = (text: string) => { state.error = text; state.message = ""; render(); };

  function confirmRemove(name: string) { if (!state.draft) return; state.draft = removeCollectionField(state.draft, name); state.removal = ""; startCreate(); say(`Removed field "${name}" from the draft schema.`); }
  function saveBuilder() {
    if (!state.draft) return;
    const input: ContentFieldBuilderInput = { ...state.input, options: state.optionsText.split("\n").map(value => value.trim()).filter(Boolean) };
    const issue = validateBuilderInput(input);
    if (issue) { fail(issue); return; }
    try {
      state.draft = state.mode === "edit" ? updateCollectionField(state.draft, input.name, input) : insertCollectionField(state.draft, input);
      state.selected = input.name.trim();
      const message = state.mode === "edit" ? `Updated field "${input.name.trim()}".` : `Prepared field "${input.name.trim()}" in the draft schema.`;
      if (state.mode === "create") startCreate(input.kind);
      say(message);
    } catch (cause) { fail(cause instanceof Error ? cause.message : String(cause)); }
  }

  const text = (name: string, title: string, value: string, placeholder: string, onInput: (value: string) => void, disabled = false) => {
    const input = node("input", { name, value, placeholder, "aria-label": title, ...(disabled ? { disabled: "" } : {}) });
    input.addEventListener("input", () => onInput(input.value));
    return input;
  };
  const numeric = (title: string, value: number | undefined, onChange: (value: number | undefined) => void) => {
    const input = node("input", { value: value === undefined ? "" : String(value), placeholder: title, "aria-label": title, inputmode: "numeric" });
    input.addEventListener("input", () => { const raw = input.value.trim(); onChange(raw ? Number(raw) : undefined); });
    return input;
  };
  const toggle = (title: string, checked: boolean, onChange: (value: boolean) => void) => {
    const box = node("input", { type: "checkbox", ...(checked ? { checked: "" } : {}) });
    box.addEventListener("change", () => onChange(box.checked));
    return node("label", {}, node("span", {}, title), box);
  };

  function configForm() {
    const input = state.input;
    const set = (change: Partial<ContentFieldBuilderInput>) => { state.input = { ...state.input, ...change }; };
    const nameBox = text("name", "Field name", input.name, "authorBio", value => set({ name: value }), state.mode === "edit");
    const labelBox = text("label", "Field label", input.label ?? "", "Author Bio", value => { set({ label: value }); if (state.mode === "create" && !state.input.name.trim()) { nameBox.value = slugifyFieldName(value); set({ name: nameBox.value }); } });
    const description = node("textarea", { rows: "3", placeholder: "Optional field description", "aria-label": "Field description" }, input.description ?? "");
    description.addEventListener("input", () => set({ description: description.value }));
    const kind = input.kind;
    const textKind = kind === "text" || kind === "long-text" || kind === "slug";
    const numberKind = kind === "number" || kind === "integer";
    const hasPlaceholder = ["text", "long-text", "number", "integer", "json", "slug", "url"].includes(kind);
    const options = node("textarea", { rows: "5", placeholder: "Option 1\nOption 2\nOption 3", "aria-label": "Options" }, state.optionsText);
    options.addEventListener("input", () => { state.optionsText = options.value; });
    const parts: (Node | undefined)[] = [
      node("div", { class: "k-grid cols-2" }, labelBox, nameBox), description,
      node("div", { class: "k-grid cols-2" }, text("group", "Field group", input.group ?? "", "Content", value => set({ group: value })), hasPlaceholder ? text("placeholder", "Field placeholder", input.placeholder ?? "", "Placeholder", value => set({ placeholder: value })) : undefined as unknown as Node),
      text("helpText", "Field help text", input.helpText ?? "", "Help text shown to editors", value => set({ helpText: value })),
      toggle("Required field", input.required ?? false, value => set({ required: value })),
      textKind ? node("div", { class: "k-grid cols-3" }, numeric("Min length", input.minLength, value => set({ minLength: value })), numeric("Max length", input.maxLength, value => set({ maxLength: value })), text("pattern", "Validation pattern", input.pattern ?? "", kind === "slug" ? "^[a-z0-9]+(?:-[a-z0-9]+)*$" : "Pattern", value => set({ pattern: value }))) : undefined,
      numberKind ? node("div", { class: "k-grid cols-2" }, numeric("Min value", input.min, value => set({ min: value })), numeric("Max value", input.max, value => set({ max: value }))) : undefined,
      kind === "select" || kind === "multi-select" || kind === "status" ? options : undefined,
      kind === "multi-select" || kind === "repeater" ? node("div", { class: "k-grid cols-2" }, numeric("Min items", input.minItems, value => set({ minItems: value })), numeric("Max items", input.maxItems, value => set({ maxItems: value }))) : undefined,
      kind === "long-text" || kind === "json" ? numeric("Rows", input.rows, value => set({ rows: value })) : undefined,
      kind === "relation" ? node("div", { class: "form" }, text("relationCollection", "Related collection", input.relationCollection ?? "", "posts", value => set({ relationCollection: value })), toggle("Allow multiple references", input.relationMultiple ?? false, value => set({ relationMultiple: value }))) : undefined,
      kind === "slug" ? text("from", "Slug source field", input.from ?? "", "Generate from field, for example title", value => set({ from: value })) : undefined,
      FILE_KINDS.has(kind) ? numeric("Max size in bytes", input.maxSize, value => set({ maxSize: value })) : undefined,
      kind === "repeater" ? nestedEditor() : undefined,
      node("div", { class: "actions" }, button(state.mode === "edit" ? "Update Field" : "Add Field", saveBuilder, { class: "primary" }), ...(state.mode === "edit" ? [button("Cancel", () => { startCreate(); render(); })] : []))
    ];
    return node("div", { class: "k-card" }, ...parts.filter((part): part is Node => part !== undefined));
  }

  function nestedEditor() {
    const nested = state.input.nestedFields ?? [];
    let nestedName = "", nestedLabel = "", nestedKind: ContentFieldBuilderKind = "text";
    const kindSelect = node("select", { "aria-label": "Nested field type" }, ...(["text", "long-text", "number", "integer", "boolean"] as const).map(value => node("option", { value }, FIELD_TYPES.find(entry => entry.value === value)!.label)));
    kindSelect.addEventListener("change", () => { nestedKind = kindSelect.value as ContentFieldBuilderKind; });
    const add = () => {
      const name = nestedName.trim() || slugifyFieldName(nestedLabel);
      if (validateCollectionFieldName(name) || nested.some(entry => entry.name === name)) return;
      state.input = { ...state.input, nestedFields: [...nested, contentBuilderInputToEntry({ name, label: nestedLabel.trim() || undefined, kind: nestedKind, required: false })] };
      render();
    };
    return node("div", { class: "k-card" },
      node("div", { class: "toolbar" }, node("strong", {}, "Nested fields"), node("span", { class: "muted" }, `${nested.length} fields`)),
      ...(nested.length ? nested.map(entry => node("div", { class: "k-row" }, node("div", {}, node("p", { class: "k-row-label" }, entry.field.label), node("p", { class: "k-row-detail" }, `${entry.name} · ${entry.field._tag}`)), button("Remove", () => { state.input = { ...state.input, nestedFields: nested.filter(item => item.name !== entry.name) }; render(); }, { "aria-label": `Remove ${entry.name}`, class: "danger" }))) : [node("p", { class: "muted" }, "Repeaters need at least one nested field for editors to fill in.")]),
      node("div", { class: "k-grid cols-3" }, text("nestedName", "Nested field name", "", "fieldName", value => { nestedName = value; }), text("nestedLabel", "Nested field label", "", "Field label", value => { nestedLabel = value; }), kindSelect),
      button("Add nested field", add));
  }

  function fieldsView() {
    const fields = getContentSchemaFields(state.draft ?? []);
    const groups = new Map<string, typeof fields>();
    for (const entry of fields) { const group = getContentSchemaUi(entry.definition)?.group?.trim() || "Content"; groups.set(group, [...(groups.get(group) ?? []), entry]); }
    const selected = fields.find(entry => entry.name === state.selected) ?? fields[0];
    const selectedEntry = state.draft?.find(entry => entry.name === selected?.name);
    const documents = state.documentCount;

    const list = node("section", { class: "k-card" }, node("h2", {}, "Fields"),
      ...(!state.draft ? [resourceNotice("No active schema", "Activate a schema to edit fields.")] : [
        button("New Field", () => { startCreate(); render(); }, { class: "primary" }),
        ...[...groups.entries()].map(([group, members]) => node("div", { class: "k-stack" }, node("div", { class: "toolbar" }, node("strong", {}, group), node("span", { class: "muted" }, `${members.length} fields`)),
          ...members.map(member => { const item = button("", () => { state.selected = member.name; render(); }, { class: `builder-field${selected?.name === member.name ? " active" : ""}` }); item.append(node("span", {}, node("strong", {}, member.label), node("small", { class: "muted block" }, `${member.name} · ${fieldTypeName(member.definition)}`)), node("small", { class: "muted" }, member.required ? "Required" : "Optional")); return item; })))]));

    const builder = node("section", { class: "k-card" },
      node("div", { class: "toolbar" }, node("h2", {}, state.mode === "edit" ? "Edit field" : "Field builder"), button("Save & Activate", () => { const current = active(); if (state.draft && current) fork(saveSchema(state.draft, (current.version ?? 0) + 1), () => { state.message = `Saved and activated schema v${(current.version ?? 0) + 1}.`; }); }, { class: "primary", ...(!state.draft || !active() || state.saving ? { disabled: "" } : {}) })),
      ...(!state.draft ? [resourceNotice("No active schema", "Create or activate a schema before using the builder.")] : [
        node("div", { class: "k-grid cols-3" }, ...FIELD_TYPES.map(option => { const item = button("", () => { state.input = { ...state.input, kind: option.value, nestedFields: option.value === "repeater" ? state.input.nestedFields ?? [] : state.input.nestedFields }; if (option.value === "status" && !state.optionsText.trim()) state.optionsText = STATUS_OPTIONS; render(); }, { class: `builder-type${state.input.kind === option.value ? " active" : ""}`, "aria-pressed": String(state.input.kind === option.value) }); item.append(node("strong", {}, option.label), node("small", { class: "muted block" }, option.description)); return item; })),
        configForm()]));

    const previewContext = { related: {}, media: [], files: [] };
    const preview = node("section", { class: "k-card" }, node("h2", {}, "Document form preview"),
      ...(!state.draft || fields.length === 0 ? [resourceNotice("No fields to preview", "Add fields to the draft schema to preview the entry editor.")]
        : fields.map(entry => fieldEditor({ name: entry.name, label: entry.label, description: entry.description, required: entry.required, definition: entry.definition, value: state.preview[entry.name] ?? createPreviewFieldValue(entry.definition) }, previewContext, value => { state.preview[entry.name] = value; }))));

    const detail = node("section", { class: "k-card" }, node("h2", {}, "Selected field"),
      ...(!state.draft || !selected || !selectedEntry ? [resourceNotice("Pick or create a field", "Select a field to inspect its editor behavior.")] : [
        ...(state.removal === selected.name ? [resourceNotice("Remove field from schema?", `This collection has ${documents} existing ${documents === 1 ? "entry" : "entries"}. Removing "${selected.name}" will not delete stored values, but those values will no longer be validated or editable until you migrate them.`)] : []),
        node("div", { class: "toolbar" }, node("div", {}, node("strong", {}, selected.label), node("p", { class: "muted" }, `${selected.name} · ${fieldTypeName(selected.definition)}`)),
          state.removal === selected.name ? node("div", { class: "actions" }, button("Cancel", () => { state.removal = ""; render(); }), button("Confirm remove", () => confirmRemove(selected.name), { class: "danger" }))
            : button("Remove", () => { if (documents > 0) { state.removal = selected.name; state.message = ""; state.error = ""; render(); } else confirmRemove(selected.name); }, { class: "danger" })),
        node("div", { class: "actions" }, button("Move up", () => { state.draft = moveCollectionField(state.draft!, selected.name, -1); say(`Reordered field "${selected.name}".`); }), button("Move down", () => { state.draft = moveCollectionField(state.draft!, selected.name, 1); say(`Reordered field "${selected.name}".`); }), button("Edit field", () => { startEdit(selectedEntry); render(); })),
        node("div", { class: "k-grid cols-2" }, ...[["Editor", editorName(selected.definition)], ["Required", selected.required ? "Yes" : "No"], ["Group", getContentSchemaUi(selected.definition)?.group ?? "Content"], ["Schema type", String(selected.definition.type ?? "custom")]].map(([title, value]) => node("div", { class: "k-stat" }, node("span", {}, title), node("strong", {}, value)))),
        node("pre", {}, JSON.stringify(selectedEntry.field, null, 2))]));
    const json = node("section", { class: "k-card" }, node("h2", {}, "Draft schema JSON"), state.draft ? node("pre", {}, JSON.stringify(state.draft, null, 2)) : resourceNotice("No active schema", "Save a schema version to preview it here."));
    return node("div", { class: "builder-layout" }, list, builder, node("div", { class: "k-stack" }, preview, detail, json));
  }

  function editorView() {
    const textarea = node("textarea", { rows: "28", spellcheck: "false", "aria-label": "Schema JSON" }, state.json);
    textarea.addEventListener("input", () => { state.json = textarea.value; });
    const current = active();
    return node("div", { class: "k-grid cols-2" },
      node("section", { class: "k-card" }, node("div", { class: "toolbar" }, node("h2", {}, "Type Editor"), button("Save & Activate", () => {
        if (!current) return;
        try { const parsed = parseCollectionFieldEntriesJson(state.json); fork(saveSchema(parsed, current.version + 1), () => { state.message = `Saved and activated schema v${current.version + 1}.`; }); } catch (cause) { fail(cause instanceof Error ? cause.message : String(cause)); }
      }, { class: "primary", ...(state.saving || !current ? { disabled: "" } : {}) })), ...(current ? [] : [resourceNotice("No active schema", "Create or activate a schema before editing the raw field definition.")]), textarea),
      node("section", { class: "k-card" }, node("h2", {}, "Schema versions"), ...(state.schemas.length === 0 ? [resourceNotice("No versions", "This content type has no saved schemas yet.")] : [...state.schemas].sort((left, right) => right.version - left.version).map(schema => node("div", { class: "k-row" }, node("div", {}, node("p", { class: "k-row-label" }, `v${schema.version}`), node("p", { class: "k-row-detail" }, schema.active ? "Active" : `${schema.fields.length} fields`)),
        button("Activate version", () => fork(request(`${api}/database/schemas/${encodeURIComponent(type)}/activate`, "POST", { tenantId: tenant, version: schema.version }).pipe(Effect.flatMap(() => reload)), () => { state.message = `Activated schema v${schema.version}.`; }), schema.active || state.saving ? { disabled: "" } : {}))))));
  }

  function settingsView() {
    const current = active();
    const pinned = state.pinned.includes(type);
    let labelDraft = state.labels[type] ?? type, copyLabel = `${type} Copy`, copyName = `${type}-copy`;
    return node("div", { class: "k-grid cols-2" },
      node("section", { class: "k-card flush" }, node("h2", {}, "Content type settings"),
        ...[["Collection", type], ["Entries", String(state.documentCount)], ["Active schema", current ? `v${current.version}` : "No active schema"]].map(([title, value]) => node("div", { class: "k-row" }, node("div", {}, node("p", { class: "k-row-label" }, title), node("p", { class: "k-row-detail" }, value)))),
        node("div", { class: "k-row" }, node("div", { class: "k-stack" }, node("label", {}, node("span", {}, "Editor label"), text("editorLabel", "Editor label", labelDraft, type, value => { labelDraft = value; })),
          node("div", { class: "actions" }, button("Save label", () => { if (!labelDraft.trim()) return; const labels = { ...state.labels, [type]: labelDraft.trim() }; fork(savePreferences(labels, state.pinned), () => { state.labels = labels; state.message = `Updated editor label for ${type}.`; }); }, { class: "primary" }),
            button(pinned ? "Unpin" : "Pin", () => { const next = pinned ? state.pinned.filter(name => name !== type) : [...state.pinned, type]; fork(savePreferences(state.labels, next), () => { state.pinned = next; state.message = pinned ? `Removed ${type} from pinned content types.` : `Pinned ${type} to the top of Content Studio.`; }); }))))),
      node("section", { class: "k-card" }, node("h2", {}, "Duplicate this content type"),
        node("label", {}, node("span", {}, "New label"), text("copyLabel", "New label", copyLabel, "Articles Copy", value => { copyLabel = value; })),
        node("label", {}, node("span", {}, "New collection name"), text("copyName", "New collection name", copyName, "articles-copy", value => { copyName = value; })),
        node("p", { class: "muted" }, "Duplication copies the active schema and keeps entries separate, which is usually the right starting point for a fresh content model."),
        button("Duplicate content type", () => {
          if (!copyName.trim()) return;
          const name = copyName.trim();
          fork(Effect.gen(function*() {
            const created = object(yield* request(`${api}/database/documents/collections`, "POST", { tenantId: tenant, name, surface: "content-studio", metadata: { kind: "content-type", duplicatedFrom: type } }));
            const createdName = label(created.name, name);
            if (current) yield* request(`${api}/database/schemas/${encodeURIComponent(createdName)}`, "POST", { tenantId: tenant, version: 1, activate: true, fields: current.fields });
            yield* savePreferences(copyLabel.trim() && copyLabel.trim() !== createdName ? { ...state.labels, [createdName]: copyLabel.trim() } : state.labels, state.pinned);
          }), () => { state.message = `Duplicated ${type} into ${name}.`; });
        }, { class: "primary" })));
  }

  function render() {
    const tab = (view: string, title: string) => button(title, () => { state.view = view; state.message = ""; state.error = ""; syncUrl(); render(); }, { class: state.view === view ? "primary" : "", "aria-pressed": String(state.view === view) });
    host.replaceChildren(
      node("div", { class: "k-card" }, node("div", { class: "actions" }, tab("fields", "Fields"), tab("editor", "Type Editor"), tab("settings", "Type Settings"))),
      ...(state.message ? [resourceNotice("Done", state.message)] : []), ...(state.error ? [resourceNotice("Action failed", state.error)] : []),
      state.view === "editor" ? editorView() : state.view === "settings" ? settingsView() : fieldsView());
  }
  void base;
  render();
  return () => { for (const fiber of fibers) Effect.runFork(Fiber.interrupt(fiber)); fibers.clear(); host.replaceChildren(); };
}
