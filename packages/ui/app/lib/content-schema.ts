import type { CollectionFieldEntry } from "./runtime-api";

export type ContentSchemaControl = "text" | "textarea" | "rich-text";
export type ContentSchemaEditor = "lexical";
export type ContentFieldBuilderKind =
  | "text"
  | "long-text"
  | "rich-text"
  | "number"
  | "boolean"
  | "status"
  | "relation"
  | "repeater"
  | "file"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "json";

export interface ContentSchemaUiDefinition {
  control?: ContentSchemaControl;
  editor?: ContentSchemaEditor;
  placeholder?: string;
  rows?: number;
  helpText?: string;
  group?: string;
  relationCollection?: string;
}

export interface ContentSchemaDefinition {
  type?: unknown;
  label?: unknown;
  description?: unknown;
  format?: unknown;
  enum?: unknown;
  required?: unknown;
  mimeTypes?: unknown;
  items?: unknown;
  properties?: unknown;
  ui?: unknown;
  [key: string]: unknown;
}

export interface ContentSchemaField {
  name: string;
  label: string;
  description?: string;
  required: boolean;
  definition: ContentSchemaDefinition;
}

export interface ContentFieldBuilderInput {
  name: string;
  label?: string;
  description?: string;
  kind: ContentFieldBuilderKind;
  required?: boolean;
  group?: string;
  placeholder?: string;
  helpText?: string;
  rows?: number;
  relationCollection?: string;
}

function humanizeFieldName(name: string): string {
  return name
    .replace(/^_+/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function getContentSchemaUi(
  definition: ContentSchemaDefinition,
): ContentSchemaUiDefinition | undefined {
  if (
    !definition.ui ||
    typeof definition.ui !== "object" ||
    Array.isArray(definition.ui)
  ) {
    return undefined;
  }

  return definition.ui as ContentSchemaUiDefinition;
}

// ─── Derive a display-layer ContentSchemaDefinition from a CollectionField ──

function collectionFieldToDefinition(
  field: CollectionFieldEntry["field"],
): ContentSchemaDefinition {
  const label = field.label;
  switch (field._tag) {
    case "RichTextField":
      return {
        type: "string",
        format: "html",
        label,
        ui: { control: "rich-text", editor: "lexical" },
      };
    case "NumberField":
      return { type: "number", label };
    case "BooleanField":
      return { type: "boolean", label };
    case "ImageField":
    case "AudioField":
    case "VideoField":
    case "FileField": {
      const accept = field.accept as string[] | undefined;
      return { type: "file", label, ...(accept?.length ? { mimeTypes: accept } : {}) };
    }
    case "RepeaterField":
      return {
        type: "array",
        label,
        items: { type: "object", additionalProperties: true },
      };
    case "TextField":
    default:
      return { type: "string", label };
  }
}

// ─── Public field utilities ───────────────────────────────────────────────────

export function getContentSchemaFields(
  entries: CollectionFieldEntry[],
): ContentSchemaField[] {
  return entries.map((entry) => ({
    name: entry.name,
    label: entry.field.label || humanizeFieldName(entry.name),
    required: entry.field.required,
    definition: collectionFieldToDefinition(entry.field),
  }));
}

export function isRichTextSchemaField(
  name: string,
  definition: ContentSchemaDefinition,
): boolean {
  if (definition.type !== "string") return false;
  const ui = getContentSchemaUi(definition);
  return (
    ui?.control === "rich-text" ||
    (typeof definition.format === "string" && definition.format === "html") ||
    name === "_content"
  );
}

export function inferFieldKindFromEntry(
  entry: CollectionFieldEntry,
): ContentFieldBuilderKind {
  switch (entry.field._tag) {
    case "RichTextField": return "rich-text";
    case "NumberField": return "number";
    case "BooleanField": return "boolean";
    case "ImageField": return "image";
    case "AudioField": return "audio";
    case "VideoField": return "video";
    case "FileField": return "file";
    case "RepeaterField": return "repeater";
    case "TextField":
    default: return "text";
  }
}

// ─── Starter schema ───────────────────────────────────────────────────────────

export function createStarterContentTypeFields(): CollectionFieldEntry[] {
  return [
    { name: "title", field: { _tag: "TextField", label: "Title", required: true } },
    { name: "slug", field: { _tag: "TextField", label: "Slug", required: true } },
    { name: "excerpt", field: { _tag: "TextField", label: "Excerpt", required: false } },
    { name: "_content", field: { _tag: "RichTextField", label: "Content", required: false } },
    { name: "status", field: { _tag: "TextField", label: "Status", required: false } },
  ];
}

export function createStarterContentEntry(timestamp = Date.now()): Record<string, unknown> {
  return {
    title: "Untitled draft",
    slug: `draft-${timestamp}`,
    excerpt: "",
    _content: "",
    status: "draft",
  };
}

// ─── Field builder input → CollectionFieldEntry ───────────────────────────────

export function contentBuilderInputToEntry(
  input: ContentFieldBuilderInput,
): CollectionFieldEntry {
  const label = input.label?.trim() || humanizeFieldName(input.name);
  const required = input.required ?? false;
  const name = input.name.trim();

  if (!name) throw new Error("A field name is required.");

  let field: CollectionFieldEntry["field"];
  switch (input.kind) {
    case "rich-text":
      field = { _tag: "RichTextField", label, required };
      break;
    case "number":
      field = { _tag: "NumberField", label, required };
      break;
    case "boolean":
      field = { _tag: "BooleanField", label, required };
      break;
    case "image":
      field = {
        _tag: "ImageField",
        label,
        required,
        accept: ["image/png", "image/jpeg", "image/webp", "image/gif"],
      };
      break;
    case "audio":
      field = {
        _tag: "AudioField",
        label,
        required,
        accept: ["audio/mpeg", "audio/wav", "audio/ogg", "audio/webm"],
      };
      break;
    case "video":
      field = {
        _tag: "VideoField",
        label,
        required,
        accept: ["video/mp4", "video/webm", "video/ogg", "video/quicktime"],
      };
      break;
    case "document":
      field = {
        _tag: "FileField",
        label,
        required,
        accept: [
          "application/pdf",
          "text/plain",
          "application/json",
          "application/zip",
        ],
      };
      break;
    case "file":
      field = { _tag: "FileField", label, required };
      break;
    case "repeater":
      field = { _tag: "RepeaterField", label, required, fields: [] };
      break;
    case "text":
    case "long-text":
    case "status":
    case "relation":
    case "json":
    default:
      field = { _tag: "TextField", label, required };
      break;
  }

  return { name, field };
}

// ─── Schema draft mutations (operate on CollectionFieldEntry[]) ───────────────

export function insertCollectionField(
  fields: CollectionFieldEntry[],
  input: ContentFieldBuilderInput,
): CollectionFieldEntry[] {
  const name = input.name.trim();
  if (!name) throw new Error("A field name is required.");
  if (fields.some((f) => f.name === name)) {
    throw new Error(`A field named "${name}" already exists.`);
  }
  return [...fields, contentBuilderInputToEntry(input)];
}

export function updateCollectionField(
  fields: CollectionFieldEntry[],
  fieldName: string,
  input: ContentFieldBuilderInput,
): CollectionFieldEntry[] {
  if (!fields.some((f) => f.name === fieldName)) {
    throw new Error(`The field "${fieldName}" does not exist.`);
  }
  return fields.map((f) =>
    f.name === fieldName ? contentBuilderInputToEntry({ ...input, name: fieldName }) : f,
  );
}

export function removeCollectionField(
  fields: CollectionFieldEntry[],
  fieldName: string,
): CollectionFieldEntry[] {
  return fields.filter((f) => f.name !== fieldName);
}

export function moveCollectionField(
  fields: CollectionFieldEntry[],
  fieldName: string,
  direction: -1 | 1,
): CollectionFieldEntry[] {
  const index = fields.findIndex((f) => f.name === fieldName);
  const next = index + direction;
  if (index === -1 || next < 0 || next >= fields.length) return fields;
  const reordered = [...fields];
  [reordered[index], reordered[next]] = [reordered[next], reordered[index]];
  return reordered;
}

// ─── Form value helpers (used by entry editor) ────────────────────────────────

export function normalizeSchemaFieldValue(
  definition: ContentSchemaDefinition,
  rawValue: unknown,
): unknown {
  if (rawValue === undefined) return undefined;

  switch (definition.type) {
    case "number": {
      if (rawValue === "" || rawValue === null) return undefined;
      const numeric = Number(rawValue);
      return Number.isFinite(numeric) ? numeric : rawValue;
    }
    case "boolean":
      return Boolean(rawValue);
    case "object":
    case "array":
    case "file":
      if (typeof rawValue !== "string") return rawValue;
      if (rawValue.trim().length === 0) return undefined;
      return JSON.parse(rawValue) as unknown;
    default:
      return rawValue;
  }
}

export function stringifySchemaFieldValue(
  definition: ContentSchemaDefinition,
  value: unknown,
): string {
  if (value === undefined || value === null) return "";
  switch (definition.type) {
    case "object":
    case "array":
    case "file":
      return JSON.stringify(value, null, 2);
    case "boolean":
      return value ? "true" : "false";
    default:
      return String(value);
  }
}
