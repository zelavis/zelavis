import { button, node } from "./dom.ts";
import { getContentSchemaUi, getReferenceCollection, getRepeaterNestedDefinitions, isMultiSelectSchemaField, isReferenceMultiple, isReferenceSchemaField, isRepeaterSchemaField, isRichTextSchemaField, type ContentSchemaDefinition } from "./content-schema.ts";

/**
 * Entry field editors, one per schema field type. Each takes its current value and reports every change; composite
 * fields (a repeater, a multi-select, a reference list) rebuild their own contents when the value they hold changes,
 * so the caller only ever keeps the value.
 */
export interface MediaItem { src: string; altText: string; label: string }
export interface FileItem { href: string; label: string; meta: string }
export interface FieldContext {
  /** The entries of every collection a reference field points at, read before the form was built. */
  related: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  media: readonly MediaItem[];
  files: readonly FileItem[];
}
export interface FieldSpec { name: string; label: string; description?: string; required: boolean; definition: ContentSchemaDefinition; value: unknown }

/** The collections the reference fields of these definitions read from, including those inside repeaters. */
export function referencedCollections(definitions: readonly ContentSchemaDefinition[]): string[] {
  const found = new Set<string>();
  const visit = (definition: ContentSchemaDefinition) => {
    const collection = getReferenceCollection(definition);
    if (isReferenceSchemaField(definition) && collection) found.add(collection);
    if (isRepeaterSchemaField(definition)) for (const nested of Object.values(getRepeaterNestedDefinitions(definition))) visit(nested);
  };
  definitions.forEach(visit);
  return [...found];
}

export function toDateTimeLocalValue(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return "";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const offset = new Date(timestamp).getTimezoneOffset();
  return new Date(timestamp - offset * 60_000).toISOString().slice(0, 16);
}

const titleOf = (document: Record<string, unknown>) => String(object(document.data).title ?? document.id);
const slugOf = (document: Record<string, unknown>) => object(document.data).slug ? ` · ${String(object(document.data).slug)}` : "";
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
const textOf = (value: unknown) => typeof value === "string" ? value : "";

export function fieldEditor(spec: FieldSpec, context: FieldContext, onChange: ((value: unknown) => void) | undefined): HTMLElement {
  const ui = getContentSchemaUi(spec.definition);
  const placeholder = typeof ui?.placeholder === "string" ? ui.placeholder : `Enter ${spec.label.toLowerCase()}`;
  const input = fieldInput(spec.name, spec.definition, spec.value, placeholder, context, onChange);
  return node("label", { class: "field-editor" },
    node("span", { class: "field-title" }, spec.label, ...(spec.required ? [node("small", { class: "k-badge" }, "Required")] : [])),
    ...(spec.description ? [node("small", { class: "muted" }, spec.description)] : []),
    input,
    ...(spec.definition.type === "file" ? [node("small", { class: "muted" }, "Paste a Zelavis file reference JSON from Media or Backend > Storage.")] : []));
}

function fieldInput(name: string, definition: ContentSchemaDefinition, value: unknown, placeholder: string, context: FieldContext, onChange: ((value: unknown) => void) | undefined): HTMLElement {
  const disabled = onChange === undefined;
  const report = (next: unknown) => onChange?.(next);
  const ui = getContentSchemaUi(definition);

  if (definition.type === "boolean") {
    const box = node("input", { type: "checkbox", ...(Boolean(value) ? { checked: "" } : {}), ...(disabled ? { disabled: "" } : {}) });
    const text = node("span", { class: "muted" }, Boolean(value) ? "Enabled" : "Disabled");
    box.addEventListener("change", () => { text.textContent = box.checked ? "Enabled" : "Disabled"; report(box.checked); });
    return node("div", { class: "field-switch" }, box, text);
  }

  if (isRichTextSchemaField(name, definition)) {
    if (disabled) return node("textarea", { rows: "6", disabled: "", placeholder }, textOf(value));
    const island = document.createElement("fuzor-island");
    island.setAttribute("src", "rich-text");
    island.setAttribute("props", JSON.stringify({ value: textOf(value), placeholder, mediaItems: context.media, fileItems: context.files }));
    island.addEventListener("rich-change", event => report(String((event as CustomEvent<string>).detail)));
    return island;
  }

  if (isReferenceSchemaField(definition)) return referenceInput(definition, value, context, disabled, report);

  if (isMultiSelectSchemaField(definition)) return multiSelectInput(definition, Array.isArray(value) ? value : [], disabled, report);

  if (isRepeaterSchemaField(definition)) return repeaterInput(definition, Array.isArray(value) ? value : [], context, disabled, report);

  if (definition.type === "string" && Array.isArray(definition.enum) && definition.enum.every(entry => typeof entry === "string")) {
    const select = node("select", { ...(disabled ? { disabled: "" } : {}) }, node("option", { value: "" }, "Select…"), ...(definition.enum as string[]).map(entry => node("option", { value: entry, ...(entry === value ? { selected: "" } : {}) }, entry)));
    select.addEventListener("change", () => report(select.value));
    return select;
  }

  if (ui?.control === "datetime") {
    const field = node("input", { type: "datetime-local", value: toDateTimeLocalValue(value), placeholder, ...(disabled ? { disabled: "" } : {}) });
    field.addEventListener("input", () => report(field.value ? new Date(field.value).toISOString() : ""));
    return field;
  }

  if (definition.type === "object" || definition.type === "file" || ui?.control === "textarea" || ui?.control === "json") {
    const area = node("textarea", { rows: String(typeof ui?.rows === "number" ? ui.rows : definition.type === "string" ? 4 : 10), placeholder, ...(disabled ? { disabled: "" } : {}) }, textOf(value));
    area.addEventListener("input", () => report(area.value));
    return area;
  }

  const type = definition.type === "number" || definition.type === "integer" ? "number" : ui?.control === "url" ? "url" : "text";
  const field = node("input", { type, value: textOf(value), placeholder, ...(type === "number" ? { step: definition.type === "integer" ? "1" : "any" } : {}), ...(disabled ? { disabled: "" } : {}) });
  field.addEventListener("input", () => report(field.value));
  return field;
}

function referenceInput(definition: ContentSchemaDefinition, value: unknown, context: FieldContext, disabled: boolean, report: (value: unknown) => void): HTMLElement {
  const collection = getReferenceCollection(definition);
  const multiple = isReferenceMultiple(definition);
  const documents = collection ? context.related[collection] ?? [] : [];
  const search = node("input", { type: "search", placeholder: "Search related entries", "aria-label": "Search related entries", ...(disabled ? { disabled: "" } : {}) });
  const host = node("div", { class: "field-reference" }, search);
  const hint = node("small", { class: "muted" }, collection ? `Links to entries in ${collection}.` : "No relation target collection configured yet.");
  const selected = multiple && Array.isArray(value) ? value.filter((item): item is { collection: string; id: string } => typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string") : [];
  const current = typeof value === "object" && value && typeof (value as { id?: unknown }).id === "string" ? (value as { id: string }).id : typeof value === "string" ? value : "";
  const matches = () => { const query = search.value.trim().toLowerCase(); return documents.filter(document => !query || titleOf(document).toLowerCase().includes(query) || String(object(document.data).slug ?? "").toLowerCase().includes(query) || String(document.id).toLowerCase().includes(query)); };

  const list = node("div", { class: "field-options" });
  const drawMultiple = () => {
    list.replaceChildren(...matches().map(document => {
      const id = String(document.id);
      const box = node("input", { type: "checkbox", ...(selected.some(item => item.id === id) ? { checked: "" } : {}), ...(disabled ? { disabled: "" } : {}) });
      box.addEventListener("change", () => {
        if (box.checked) selected.push({ collection: collection ?? "", id }); else selected.splice(selected.findIndex(item => item.id === id), 1);
        report([...selected]);
      });
      return node("label", { class: "field-option" }, box, node("span", {}, `${titleOf(document)}${slugOf(document)}`));
    }));
  };
  const select = node("select", { ...(disabled ? { disabled: "" } : {}) });
  const drawSingle = () => {
    select.replaceChildren(node("option", { value: "" }, "Select related entry…"), ...matches().map(document => node("option", { value: String(document.id), ...(String(document.id) === current ? { selected: "" } : {}) }, `${titleOf(document)}${slugOf(document)}`)));
  };
  select.addEventListener("change", () => report(select.value ? { collection: collection ?? "", id: select.value } : undefined));
  const draw = multiple ? drawMultiple : drawSingle;
  search.addEventListener("input", draw);
  draw();
  host.append(multiple ? list : select, hint);
  return host;
}

function optionsOf(definition: ContentSchemaDefinition): string[] {
  const own = getContentSchemaUi(definition)?.options?.filter((entry): entry is string => typeof entry === "string");
  if (own) return own;
  const items = definition.items;
  return items && typeof items === "object" && !Array.isArray(items) && Array.isArray((items as { enum?: unknown }).enum) ? (items as { enum: unknown[] }).enum.filter((entry): entry is string => typeof entry === "string") : [];
}

function multiSelectInput(definition: ContentSchemaDefinition, value: unknown[], disabled: boolean, report: (value: unknown) => void): HTMLElement {
  const current = [...value];
  return node("div", { class: "field-options" }, ...optionsOf(definition).map(option => {
    const box = node("input", { type: "checkbox", ...(current.includes(option) ? { checked: "" } : {}), ...(disabled ? { disabled: "" } : {}) });
    box.addEventListener("change", () => {
      if (box.checked) current.push(option); else current.splice(current.indexOf(option), 1);
      report([...current]);
    });
    return node("label", { class: "field-option" }, box, node("span", {}, option));
  }));
}

function repeaterInput(definition: ContentSchemaDefinition, value: unknown[], context: FieldContext, disabled: boolean, report: (value: unknown) => void): HTMLElement {
  const items = value.map(item => object(item));
  const nested = Object.entries(getRepeaterNestedDefinitions(definition));
  const host = node("div", { class: "field-repeater" });
  const commit = () => { report(items.map(item => ({ ...item }))); draw(); };
  const draw = () => {
    host.replaceChildren(
      node("div", { class: "toolbar" }, node("strong", {}, "Repeater items"), button("Add item", () => { items.push({}); commit(); }, disabled ? { disabled: "" } : {})),
      ...(items.length === 0 ? [node("p", { class: "muted" }, "No items yet. Add the first repeatable item above.")] : items.map((item, index) => node("div", { class: "field-repeater-item" },
        node("div", { class: "toolbar" }, node("strong", {}, `Item ${index + 1}`), node("div", { class: "actions" },
          button("Up", () => { if (index > 0) { [items[index - 1], items[index]] = [items[index], items[index - 1]]; commit(); } }, { "aria-label": "Move up", ...(disabled ? { disabled: "" } : {}) }),
          button("Down", () => { if (index < items.length - 1) { [items[index + 1], items[index]] = [items[index], items[index + 1]]; commit(); } }, { "aria-label": "Move down", ...(disabled ? { disabled: "" } : {}) }),
          button("Remove", () => { items.splice(index, 1); commit(); }, { "aria-label": "Remove item", class: "danger", ...(disabled ? { disabled: "" } : {}) }))),
        ...(nested.length ? nested.map(([name, nestedDefinition]) => fieldEditor({ name, label: String(nestedDefinition.label ?? name), required: Boolean(nestedDefinition.required), definition: nestedDefinition, value: item[name] }, context, disabled ? undefined : next => { item[name] = next; report(items.map(entry => ({ ...entry }))); })) : [node("p", { class: "muted" }, "Add nested fields to this repeater in the schema builder.")])))));
  };
  draw();
  return host;
}
