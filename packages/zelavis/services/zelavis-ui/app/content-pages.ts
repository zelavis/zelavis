import { Effect } from "effect";
import { ApiError, array, label, object, request, type Config, type Project } from "./api.ts";
import { buildContentTypeRows, reorderPinned, slugifyContentTypeLabel, type ContentPreferences } from "./content-studio.ts";
import { createStarterContentEntry, createStarterContentTypeFields, getContentSchemaFields, initializeFieldDraftValue, normalizeSchemaFieldValue } from "./content-schema.ts";
import { button, field, link, node } from "./dom.ts";
import { fieldEditor, referencedCollections, type FieldContext } from "./field-editors.ts";
import { badge, card, dataRow, flashNotice, page, resourceNotice, rowsCard, setFlash } from "./page-kit.ts";
import { fieldsScreen } from "./content-fields-pages.ts";
import type { ScreenContext } from "./screens.ts";

/** Project → Content Studio: content types, their entries, and the entry editor. Fields live in content-fields-pages.ts. */

export const TENANT = "zelavis-app";

interface Studio { api: string; base: string; preferences: ContentPreferences }

const read = Effect.fn("ui.contentRead")(function*(scoped: Config) {
  const api = scoped.api.basePath;
  const [collections, schemas, settings] = yield* Effect.all([
    request(`${api}/database/documents/collections?tenantId=${encodeURIComponent(TENANT)}`),
    request(`${api}/database/schemas/collections?tenantId=${encodeURIComponent(TENANT)}`).pipe(Effect.catch(() => Effect.succeed({ collections: [] }))),
    request(`${api}/runtime/settings`).pipe(Effect.catch(() => Effect.succeed({})))
  ]);
  const preferences = object(object(object(settings).preferences).content);
  const rows = buildContentTypeRows(
    array(object(collections).collections).map(object).map(entry => ({ name: label(entry.name, ""), surface: typeof entry.surface === "string" ? entry.surface : undefined, documentCount: Number(entry.documentCount) || 0, tenantId: label(entry.tenantId, TENANT) })),
    array(object(schemas).collections).map(object).map(entry => ({ collection: label(entry.collection, ""), activeVersion: typeof entry.activeVersion === "number" ? entry.activeVersion : null, versions: array(entry.versions).filter((value): value is number => typeof value === "number") })),
    { pinnedTypes: array(preferences.pinnedTypes).map(String), labels: Object.fromEntries(Object.entries(object(preferences.labels)).filter(([, value]) => typeof value === "string")) as Record<string, string> });
  return { rows, preferences: { pinnedTypes: array(preferences.pinnedTypes).map(String), labels: Object.fromEntries(Object.entries(object(preferences.labels)).filter(([, value]) => typeof value === "string")) as Record<string, string> } satisfies ContentPreferences };
});

export const contentScreen = Effect.fn("ui.contentScreen")(function*(context: ScreenContext, project: Project, scoped: Config) {
  const base = `/projects/${encodeURIComponent(project.id)}/content`;
  const [first, second] = context.path.split("/").slice(4).filter(Boolean);
  const studio: Studio = { api: scoped.api.basePath, base, preferences: {} };
  const data = yield* read(scoped);
  studio.preferences = data.preferences;
  if (!first) return listScreen(context, studio, data.rows);
  if (first === "new") return newScreen(context, studio);
  const type = decodeURIComponent(first);
  const row = data.rows.find(entry => entry.name === type);
  const header = node("div", { class: "actions" }, link("Back to Content", base), link("Open Backend Database", `/projects/${encodeURIComponent(project.id)}/database`));
  if (!row) return page(header, resourceNotice("Unknown content type", `No content type named ${type} is available.`));
  if (second === "fields") return page(header, yield* fieldsScreen(context, scoped, studio, type));
  if (second) return page(header, yield* entryScreen(context, scoped, studio, type, decodeURIComponent(second)));
  return page(header, yield* entriesScreen(context, studio, type));
});

const saveContentPreferences = (api: string, update: { pinnedTypes?: readonly string[]; labels?: Record<string, string> }) =>
  request(`${api}/runtime/settings`, "PATCH", { preferences: { content: { ...(update.pinnedTypes ? { pinnedTypes: update.pinnedTypes } : {}), ...(update.labels ? { labels: update.labels } : {}) } } });

function listScreen(context: ScreenContext, studio: Studio, rows: ReturnType<typeof buildContentTypeRows>) {
  const done = (text: string) => { setFlash(text); context.refresh(); };
  const params = context.url.searchParams;
  const editing = params.get("editLabel") ?? "";
  const duplicating = params.get("duplicate") ?? "";
  const pinned = studio.preferences.pinnedTypes ?? [];
  let dragged = "";

  const header = node("div", { class: "actions" }, link("New content type", `${studio.base}/new`, { class: "primary" }), link("Open Backend Database", `${studio.base.replace(/\/content$/, "")}/database`));
  const table = node("table", {}, node("thead", {}, node("tr", {}, ...["Type", "Entries", "Schema", "Pinned", "Actions"].map(title => node("th", { scope: "col" }, title)))));
  const body = node("tbody");
  for (const row of rows) {
    const encoded = encodeURIComponent(row.name);
    const tr = node("tr", { ...(row.pinned ? { draggable: "true" } : {}) },
      node("td", {}, node("strong", {}, row.label), node("div", { class: "muted" }, `${row.name} · tenant ${row.tenantId}`)),
      node("td", {}, String(row.documentCount)),
      node("td", {}, badge(row.activeVersion ? "ready" : "planned"), ` ${row.activeVersion ? `v${row.activeVersion}` : "No active schema"}`),
      node("td", {}, row.pinned ? `#${pinned.indexOf(row.name) + 1}` : "—"),
      node("td", {}, node("div", { class: "actions" },
        link("Entries", `${studio.base}/${encoded}`), link("Fields", `${studio.base}/${encoded}/fields`),
        button("Edit label", () => context.setSearch({ editLabel: row.name, duplicate: undefined })),
        button("Duplicate", () => context.setSearch({ duplicate: row.name, editLabel: undefined })),
        button(row.pinned ? "Unpin" : "Pin", () => context.run(saveContentPreferences(studio.api, { pinnedTypes: row.pinned ? pinned.filter(name => name !== row.name) : [...pinned, row.name] }), () => done(row.pinned ? `Removed ${row.label} from pinned content types.` : `Pinned ${row.label} to the top of Content Studio.`))))));
    if (row.pinned) {
      tr.addEventListener("dragstart", () => { dragged = row.name; });
      tr.addEventListener("dragover", event => { if (dragged) event.preventDefault(); });
      tr.addEventListener("drop", event => {
        event.preventDefault();
        const next = reorderPinned(pinned, dragged, row.name);
        dragged = "";
        if (next) context.run(saveContentPreferences(studio.api, { pinnedTypes: next }), () => done(`Updated pinned order for ${row.label}.`));
      });
    }
    body.append(tr);
    if (editing === row.name) {
      const input = node("input", { value: row.label, "aria-label": `Editor label for ${row.name}` });
      const form = node("form", { class: "filters" }, input, node("button", { type: "submit", class: "primary" }, "Save label"), button("Cancel", () => context.setSearch({ editLabel: undefined })));
      form.addEventListener("submit", event => { event.preventDefault(); const text = input.value.trim(); if (text) context.run(saveContentPreferences(studio.api, { labels: { [row.name]: text } }), () => { setFlash(`Updated content type label for ${row.name}.`); context.setSearch({ editLabel: undefined }); }); });
      body.append(node("tr", {}, node("td", { colspan: "5" }, form)));
    }
    if (duplicating === row.name) {
      const copyLabel = node("input", { value: `${row.label} Copy`, placeholder: "Articles Copy", "aria-label": `Duplicate label for ${row.name}` });
      const copyName = node("input", { value: `${row.name}-copy`, placeholder: "articles-copy", "aria-label": `Duplicate collection name for ${row.name}` });
      const form = node("form", { class: "filters" }, copyLabel, copyName, node("button", { type: "submit", class: "primary" }, "Duplicate"), button("Cancel", () => context.setSearch({ duplicate: undefined })));
      form.addEventListener("submit", event => {
        event.preventDefault();
        if (!copyName.value.trim()) return;
        const name = slugifyContentTypeLabel(copyName.value) || copyName.value.trim();
        const title = copyLabel.value.trim() || copyName.value.trim();
        context.run(duplicateType(studio.api, row.name, name, title), () => { setFlash(`Duplicated ${row.name} into ${name}.`); context.setSearch({ duplicate: undefined }); });
      });
      body.append(node("tr", {}, node("td", { colspan: "5" }, form, node("p", { class: "muted" }, "Duplicate creates a new content type with the current active schema. Entries stay separate."))));
    }
  }
  table.append(body);
  return page(flashNotice("Done"), header, card("Content types", rows.length ? node("div", { class: "table-wrap" }, table) : resourceNotice("No content types yet", "Create your first content type.")));
}

const duplicateType = Effect.fn("ui.duplicateContentType")(function*(api: string, source: string, name: string, title: string) {
  const versions = array(object(yield* request(`${api}/database/schemas/${encodeURIComponent(source)}?tenantId=${encodeURIComponent(TENANT)}`)).schemas).map(object);
  const active = versions.find(schema => schema.active === true) ?? versions.at(-1);
  const created = object(yield* request(`${api}/database/documents/collections`, "POST", { tenantId: TENANT, name, surface: "content-studio", metadata: { kind: "content-type", duplicatedFrom: source } }));
  const createdName = label(created.name, name);
  if (active) yield* request(`${api}/database/schemas/${encodeURIComponent(createdName)}`, "POST", { tenantId: TENANT, version: 1, activate: true, fields: array(active.fields) });
  if (title !== createdName) yield* saveContentPreferences(api, { labels: { [createdName]: title } });
});

function newScreen(context: ScreenContext, studio: Studio) {
  const labelField = field("label", "Content type label", "text", "", false);
  const slugField = field("name", "Content type slug", "text", "", false);
  const labelInput = labelField.querySelector("input")!;
  const slugInput = slugField.querySelector("input")!;
  for (const [input, title, placeholder] of [[labelInput, "Content type label", "Articles"], [slugInput, "Content type slug", "articles"]] as const) { input.setAttribute("aria-label", title); input.setAttribute("placeholder", placeholder); }
  labelInput.addEventListener("input", () => { if (!slugInput.dataset.touched) slugInput.value = slugifyContentTypeLabel(labelInput.value); });
  slugInput.addEventListener("input", () => { slugInput.dataset.touched = "1"; });
  const form = node("form", { class: "form" }, labelField, slugField, node("div", { class: "actions" }, node("button", { type: "submit", class: "primary" }, "Create and Open Fields"), button("Cancel", () => context.navigate(studio.base))));
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (!slugInput.value.trim()) return;
    const name = slugifyContentTypeLabel(slugInput.value) || slugInput.value.trim();
    const title = labelInput.value.trim() || slugInput.value.trim();
    context.run(Effect.gen(function*() {
      const collection = object(yield* request(`${studio.api}/database/documents/collections`, "POST", { tenantId: TENANT, name, surface: "content-studio", metadata: { kind: "content-type" } }));
      const created = label(collection.name, name);
      yield* request(`${studio.api}/database/schemas/${encodeURIComponent(created)}`, "POST", { tenantId: TENANT, version: 1, activate: true, fields: createStarterContentTypeFields() });
      if (title !== created) yield* saveContentPreferences(studio.api, { labels: { ...(studio.preferences.labels ?? {}), [created]: title } });
      return created;
    }), created => context.navigate(`${studio.base}/${encodeURIComponent(created)}/fields`));
  });
  return page(node("div", { class: "actions" }, link("Back to Content", studio.base)), card("Create content type", form));
}

const entriesScreen = Effect.fn("ui.contentEntries")(function*(context: ScreenContext, studio: Studio, type: string) {
  const entries = array(object(yield* request(`${studio.api}/database/documents/${encodeURIComponent(type)}/query`, "POST", { limit: 25, tenantId: TENANT })).documents).map(object)
    .sort((left, right) => label(right.updatedAt, "") < label(left.updatedAt, "") ? -1 : label(right.updatedAt, "") > label(left.updatedAt, "") ? 1 : 0);
  const editing = context.url.searchParams.get("edit") ?? "";
  const encoded = encodeURIComponent(type);
  const done = (text: string) => { setFlash(text); context.refresh(); };
  const create = button("New Entry", () => context.run(request(`${studio.api}/database/documents/${encoded}`, "POST", { tenantId: TENANT, data: createStarterContentEntry() }), created => context.navigate(`${studio.base}/${encoded}/${encodeURIComponent(label(object(created).id, ""))}`)), { class: "primary" });
  const body = node("tbody");
  for (const entry of entries) {
    const id = label(entry.id, "");
    const data = object(entry.data);
    const open = `${studio.base}/${encoded}/${encodeURIComponent(id)}`;
    if (editing === id) {
      const title = node("input", { value: typeof data.title === "string" ? data.title : id, "aria-label": `Title for ${id}` });
      const slug = node("input", { value: typeof data.slug === "string" ? data.slug : "", "aria-label": `Slug for ${id}` });
      body.append(node("tr", {}, node("td", {}, title), node("td", {}, label(data.status, "draft")), node("td", {}, slug), node("td", {}, new Date(label(entry.updatedAt, "")).toLocaleString()),
        node("td", {}, node("div", { class: "actions" }, button("Save", () => context.run(request(`${studio.api}/database/documents/${encoded}/${encodeURIComponent(id)}`, "PATCH", { tenantId: TENANT, mode: "merge", data: { title: title.value.trim() || "Untitled draft", slug: slug.value.trim() || `draft-${Date.now()}` } }), () => { setFlash(`Updated ${id}.`); context.setSearch({ edit: undefined }); }), { class: "primary" }), button("Cancel", () => context.setSearch({ edit: undefined }))))));
      continue;
    }
    body.append(node("tr", {},
      node("td", {}, link(typeof data.title === "string" ? data.title : id, open), node("div", { class: "muted" }, id)),
      node("td", {}, typeof data.status === "string" ? data.status : "draft"),
      node("td", {}, typeof data.slug === "string" ? data.slug : "—"),
      node("td", {}, new Date(label(entry.updatedAt, "")).toLocaleString()),
      node("td", {}, node("div", { class: "actions" }, link("Edit entry", open), button("Edit title and slug", () => context.setSearch({ edit: id })),
        button("Duplicate", () => {
          const title = typeof data.title === "string" ? data.title : id;
          const slug = typeof data.slug === "string" ? data.slug : id;
          context.run(request(`${studio.api}/database/documents/${encoded}`, "POST", { tenantId: TENANT, data: { ...data, title: `${title} Copy`, slug: `${slug}-copy-${Date.now()}`, status: typeof data.status === "string" ? data.status : "draft" } }), created => done(`Duplicated ${id} into ${label(object(created).id)}.`));
        })))));
  }
  const table = node("div", { class: "table-wrap" }, node("table", {}, node("thead", {}, node("tr", {}, ...["Title", "Status", "Slug", "Updated", "Actions"].map(title => node("th", { scope: "col" }, title)))), body));
  return page(flashNotice("Done"), node("div", { class: "toolbar" }, node("h2", {}, "Entries"), create), entries.length ? card(undefined, table) : resourceNotice("No entries yet", "Create a draft entry."));
});

const entryScreen = Effect.fn("ui.contentEntry")(function*(context: ScreenContext, scoped: Config, studio: Studio, type: string, entryId: string) {
  const api = studio.api;
  const [schemas, entry, media] = yield* Effect.all([
    request(`${api}/database/schemas/${encodeURIComponent(type)}?tenantId=${encodeURIComponent(TENANT)}`),
    request(`${api}/database/documents/${encodeURIComponent(type)}/${encodeURIComponent(entryId)}?tenantId=${encodeURIComponent(TENANT)}`),
    request(`${api}/storage/files`).pipe(Effect.catch(() => Effect.succeed({ files: [] })))
  ]);
  const versions = array(object(schemas).schemas).map(object);
  const active = versions.find(schema => schema.active === true) ?? versions.at(-1);
  const fields = getContentSchemaFields(array(active?.fields) as never);
  const data = object(object(entry).data);
  const files = array(object(media).files).map(object);
  const mediaOf = (file: Record<string, unknown>) => { const metadata = object(file.metadata); return typeof metadata.label === "string" ? metadata.label : label(file.path, "").split("/").pop() ?? label(file.path); };
  const urlOf = (path: string) => `${api}/storage/files/${path.split("/").map(encodeURIComponent).join("/")}`;
  const related: Record<string, Record<string, unknown>[]> = {};
  for (const collection of referencedCollections(fields.map(entryField => entryField.definition))) {
    related[collection] = array(object(yield* request(`${api}/database/documents/${encodeURIComponent(collection)}/query`, "POST", { limit: 25, tenantId: TENANT }).pipe(Effect.catch(() => Effect.succeed({})))).documents).map(object);
  }
  const fieldContext: FieldContext = {
    related,
    media: files.filter(file => typeof file.contentType === "string" && file.contentType.startsWith("image/")).slice(0, 12).map(file => ({ src: urlOf(label(file.path, "")), altText: typeof object(file.metadata).alt === "string" ? String(object(file.metadata).alt) : mediaOf(file), label: mediaOf(file) })),
    files: files.slice(0, 16).map(file => ({ href: urlOf(label(file.path, "")), label: mediaOf(file), meta: [file.contentType, object(file.metadata).purpose].filter(value => typeof value === "string" && value).join(" · ") }))
  };

  const draft: Record<string, unknown> = {};
  for (const entryField of fields) draft[entryField.name] = initializeFieldDraftValue(entryField.definition, data[entryField.name]);
  const editors = fields.map(entryField => fieldEditor({ name: entryField.name, label: entryField.label, description: entryField.description, required: entryField.required, definition: entryField.definition, value: draft[entryField.name] }, fieldContext, value => { draft[entryField.name] = value; }));

  const save = () => {
    const updates: Record<string, unknown> = {};
    try {
      for (const entryField of fields) {
        const normalized = normalizeSchemaFieldValue(entryField.definition, draft[entryField.name]);
        if (normalized === undefined && entryField.definition.type !== "string") continue;
        // An unset choice is absent, not an empty string no option allows.
        if (normalized === "" && Array.isArray(entryField.definition.enum)) continue;
        updates[entryField.name] = normalized === undefined && entryField.definition.type === "string" ? "" : normalized;
      }
    } catch (cause) { context.run(Effect.fail(new ApiError({ message: cause instanceof Error ? cause.message : String(cause) }))); return; }
    context.run(request(`${api}/database/documents/${encodeURIComponent(type)}/${encodeURIComponent(entryId)}`, "PATCH", { tenantId: TENANT, mode: "merge", data: updates }), () => { saved.replaceChildren(resourceNotice("Done", `Saved ${entryId}.`)); });
  };
  const saved = node("div", { role: "status" });
  const form = node("div", { class: "form wide" }, ...(!active ? [resourceNotice("No active schema", "Activate a schema first.")] : fields.length === 0 ? [resourceNotice("No fields in schema", "Add fields to this schema first.")] : editors));
  return node("div", { class: "entry-layout" },
    card("Edit entry", node("div", { class: "actions" }, link("Back to Entries", `${studio.base}/${encodeURIComponent(type)}`), button("Save Entry", save, { class: "primary" })), saved, form),
    rowsCard("Entry details", dataRow("ID", entryId), dataRow("Collection", type), dataRow("Schema", active ? `v${label(active.version)}` : "No active schema"), dataRow("Updated", new Date(label(object(entry).updatedAt, "")).toLocaleString())));
});

