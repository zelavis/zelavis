import type { CollectionFieldEntry } from "./runtime-api";

export type ContentSchemaControl =
  | "text"
  | "textarea"
  | "rich-text"
  | "select"
  | "multi-select"
  | "datetime"
  | "reference"
  | "json"
  | "slug"
  | "url"
  | "repeater";
export type ContentSchemaEditor = "lexical";
export type ContentFieldBuilderKind =
  | "text"
  | "long-text"
  | "rich-text"
  | "number"
  | "integer"
  | "boolean"
  | "datetime"
  | "status"
  | "select"
  | "multi-select"
  | "relation"
  | "repeater"
  | "file"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "json"
  | "slug"
  | "url";

export interface ContentSchemaUiDefinition {
  control?: ContentSchemaControl;
  editor?: ContentSchemaEditor;
  placeholder?: string;
  rows?: number;
  helpText?: string;
  group?: string;
  relationCollection?: string;
  relationMultiple?: boolean;
  options?: string[];
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
  relationMultiple?: boolean;
  options?: string[];
  nestedFields?: CollectionFieldEntry[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  maxSize?: number;
  from?: string;
}

export const COLLECTION_FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const VALID_COLLECTION_FIELD_TAGS = new Set([
  "TextField",
  "LongTextField",
  "RichTextField",
  "NumberField",
  "IntegerField",
  "BooleanField",
  "DateTimeField",
  "SelectField",
  "MultiSelectField",
  "ImageField",
  "AudioField",
  "VideoField",
  "FileField",
  "ReferenceField",
  "JsonField",
  "SlugField",
  "UrlField",
  "RepeaterField",
]);

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
  const base = {
    label,
    description: field.description,
    ui: {
      placeholder: field.placeholder,
      helpText: field.helpText,
      group: field.group,
    },
  };
  switch (field._tag) {
    case "RichTextField":
      return {
        ...base,
        type: "string",
        format: "html",
        ui: { ...base.ui, control: "rich-text", editor: "lexical" },
      };
    case "LongTextField":
      return {
        ...base,
        type: "string",
        minLength: field.minLength,
        maxLength: field.maxLength,
        ui: { ...base.ui, control: "textarea", rows: field.rows },
      };
    case "NumberField":
      return { ...base, type: "number", minimum: field.min, maximum: field.max };
    case "IntegerField":
      return {
        ...base,
        type: "integer",
        minimum: field.min,
        maximum: field.max,
      };
    case "BooleanField":
      return { ...base, type: "boolean" };
    case "DateTimeField":
      return {
        ...base,
        type: "string",
        format: "date-time",
        minimum: field.min,
        maximum: field.max,
        ui: { ...base.ui, control: "datetime" },
      };
    case "SelectField":
      return {
        ...base,
        type: "string",
        enum: field.options,
        ui: { ...base.ui, control: "select", options: field.options },
      };
    case "MultiSelectField":
      return {
        ...base,
        type: "array",
        items: { type: "string", enum: field.options },
        minItems: field.minItems,
        maxItems: field.maxItems,
        ui: { ...base.ui, control: "multi-select", options: field.options },
      };
    case "ImageField":
    case "AudioField":
    case "VideoField":
    case "FileField": {
      const accept = field.accept as string[] | undefined;
      return {
        ...base,
        type: "file",
        ...(accept?.length ? { mimeTypes: accept } : {}),
        maxSize: field.maxSize,
      };
    }
    case "ReferenceField":
      return {
        ...base,
        type: field.multiple ? "array" : "object",
        items: field.multiple ? { type: "object" } : undefined,
        ui: {
          ...base.ui,
          control: "reference",
          relationCollection: field.collection,
          relationMultiple: field.multiple,
        },
      };
    case "JsonField":
      return {
        ...base,
        type: "object",
        ui: { ...base.ui, control: "json", rows: field.rows },
      };
    case "SlugField":
      return {
        ...base,
        type: "string",
        format: "slug",
        pattern: field.pattern,
        ui: { ...base.ui, control: "slug", from: field.from },
      };
    case "UrlField":
      return { ...base, type: "string", format: "url", ui: { ...base.ui, control: "url" } };
    case "RepeaterField": {
      const nestedFields = field.fields as CollectionFieldEntry[];
      const properties: Record<string, ContentSchemaDefinition> = {};
      for (const nested of nestedFields) {
        properties[nested.name] = collectionFieldToDefinition(nested.field);
      }
      return {
        ...base,
        type: "array",
        minItems: field.minItems,
        maxItems: field.maxItems,
        properties,
        ui: { ...base.ui, control: "repeater" },
      };
    }
    case "TextField":
    default:
      return {
        ...base,
        type: "string",
        minLength: field.minLength,
        maxLength: field.maxLength,
        pattern: field.pattern,
        ui: { ...base.ui, control: "text" },
      };
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

export function validateCollectionFieldName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) {
    return "A field name is required.";
  }
  if (!COLLECTION_FIELD_NAME_PATTERN.test(trimmed)) {
    return 'Field names must start with a letter or underscore and contain only letters, numbers, underscores, and hyphens.';
  }
  return undefined;
}

export function isReferenceSchemaField(definition: ContentSchemaDefinition): boolean {
  return getContentSchemaUi(definition)?.control === "reference";
}

export function isMultiSelectSchemaField(definition: ContentSchemaDefinition): boolean {
  return getContentSchemaUi(definition)?.control === "multi-select";
}

export function isRepeaterSchemaField(definition: ContentSchemaDefinition): boolean {
  return getContentSchemaUi(definition)?.control === "repeater";
}

export function getReferenceCollection(definition: ContentSchemaDefinition): string | undefined {
  const collection = getContentSchemaUi(definition)?.relationCollection;
  return typeof collection === "string" && collection.length > 0 ? collection : undefined;
}

export function isReferenceMultiple(definition: ContentSchemaDefinition): boolean {
  return getContentSchemaUi(definition)?.relationMultiple === true;
}

export function getRepeaterNestedDefinitions(
  definition: ContentSchemaDefinition,
): Record<string, ContentSchemaDefinition> {
  const properties = definition.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return {};
  }
  return properties as Record<string, ContentSchemaDefinition>;
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
    case "LongTextField": return "long-text";
    case "NumberField": return "number";
    case "IntegerField": return "integer";
    case "BooleanField": return "boolean";
    case "DateTimeField": return "datetime";
    case "SelectField": return "select";
    case "MultiSelectField": return "multi-select";
    case "ImageField": return "image";
    case "AudioField": return "audio";
    case "VideoField": return "video";
    case "FileField":
      return Array.isArray(entry.field.accept) &&
        entry.field.accept.some((value) => value === "application/pdf")
        ? "document"
        : "file";
    case "ReferenceField": return "relation";
    case "JsonField": return "json";
    case "SlugField": return "slug";
    case "UrlField": return "url";
    case "RepeaterField": return "repeater";
    case "TextField":
    default: return "text";
  }
}

// ─── Starter schema ───────────────────────────────────────────────────────────

export function createStarterContentTypeFields(): CollectionFieldEntry[] {
  return [
    { name: "title", field: { _tag: "TextField", label: "Title", required: true } },
    { name: "slug", field: { _tag: "SlugField", label: "Slug", required: true, from: "title" } },
    { name: "excerpt", field: { _tag: "LongTextField", label: "Excerpt", required: false, rows: 3 } },
    { name: "_content", field: { _tag: "RichTextField", label: "Content", required: false } },
    {
      name: "status",
      field: {
        _tag: "SelectField",
        label: "Status",
        required: false,
        options: ["draft", "review", "published", "archived"],
      },
    },
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
  const base = {
    label,
    required,
    description: optionalTrim(input.description),
    placeholder: optionalTrim(input.placeholder),
    helpText: optionalTrim(input.helpText),
    group: optionalTrim(input.group),
  };
  const options = uniqueNonEmptyStrings(input.options ?? []);

  if (!name) throw new Error("A field name is required.");

  let field: CollectionFieldEntry["field"];
  switch (input.kind) {
    case "long-text":
      field = {
        _tag: "LongTextField",
        ...base,
        rows: input.rows,
        minLength: input.minLength,
        maxLength: input.maxLength,
      };
      break;
    case "rich-text":
      field = { _tag: "RichTextField", ...base };
      break;
    case "number":
      field = { _tag: "NumberField", ...base, min: input.min, max: input.max };
      break;
    case "integer":
      field = { _tag: "IntegerField", ...base, min: input.min, max: input.max };
      break;
    case "boolean":
      field = { _tag: "BooleanField", ...base };
      break;
    case "datetime":
      field = {
        _tag: "DateTimeField",
        label,
        required,
        description: optionalTrim(input.description),
        helpText: optionalTrim(input.helpText),
        group: optionalTrim(input.group),
      };
      break;
    case "select":
      field = { _tag: "SelectField", ...base, options };
      break;
    case "multi-select":
      field = {
        _tag: "MultiSelectField",
        ...base,
        options,
        minItems: input.minItems,
        maxItems: input.maxItems,
      };
      break;
    case "image":
      field = {
        _tag: "ImageField",
        ...fileBase(base),
        accept: ["image/png", "image/jpeg", "image/webp", "image/gif"],
        maxSize: input.maxSize,
      };
      break;
    case "audio":
      field = {
        _tag: "AudioField",
        ...fileBase(base),
        accept: ["audio/mpeg", "audio/wav", "audio/ogg", "audio/webm"],
        maxSize: input.maxSize,
      };
      break;
    case "video":
      field = {
        _tag: "VideoField",
        ...fileBase(base),
        accept: ["video/mp4", "video/webm", "video/ogg", "video/quicktime"],
        maxSize: input.maxSize,
      };
      break;
    case "document":
      field = {
        _tag: "FileField",
        ...fileBase(base),
        accept: [
          "application/pdf",
          "text/plain",
          "application/json",
          "application/zip",
        ],
        maxSize: input.maxSize,
      };
      break;
    case "file":
      field = { _tag: "FileField", ...fileBase(base), maxSize: input.maxSize };
      break;
    case "repeater":
      field = {
        _tag: "RepeaterField",
        label,
        required,
        description: optionalTrim(input.description),
        helpText: optionalTrim(input.helpText),
        group: optionalTrim(input.group),
        fields: input.nestedFields ?? [],
        minItems: input.minItems,
        maxItems: input.maxItems,
      };
      break;
    case "relation":
      field = {
        _tag: "ReferenceField",
        label,
        required,
        description: optionalTrim(input.description),
        helpText: optionalTrim(input.helpText),
        group: optionalTrim(input.group),
        collection: input.relationCollection?.trim() || "",
        multiple: input.relationMultiple,
      };
      break;
    case "json":
      field = {
        _tag: "JsonField",
        ...base,
        rows: input.rows,
      };
      break;
    case "slug":
      field = {
        _tag: "SlugField",
        ...base,
        from: optionalTrim(input.from),
        pattern: optionalTrim(input.pattern),
      };
      break;
    case "url":
      field = { _tag: "UrlField", ...base };
      break;
    case "status":
      field = {
        _tag: "SelectField",
        ...base,
        options: options.length > 0 ? options : ["draft", "review", "published", "archived"],
      };
      break;
    case "text":
    default:
      field = {
        _tag: "TextField",
        ...base,
        minLength: input.minLength,
        maxLength: input.maxLength,
        pattern: optionalTrim(input.pattern),
      };
      break;
  }

  return { name, field };
}

function optionalTrim(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function uniqueNonEmptyStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function fileBase(base: {
  label: string;
  required: boolean;
  description?: string;
  helpText?: string;
  group?: string;
}) {
  return {
    label: base.label,
    required: base.required,
    description: base.description,
    helpText: base.helpText,
    group: base.group,
  };
}

export function contentFieldEntryToBuilderInput(
  entry: CollectionFieldEntry,
): ContentFieldBuilderInput {
  const field = entry.field;
  const base: ContentFieldBuilderInput = {
    name: entry.name,
    label: field.label,
    description: field.description as string | undefined,
    kind: inferFieldKindFromEntry(entry),
    required: field.required,
    group: field.group as string | undefined,
    placeholder: field.placeholder as string | undefined,
    helpText: field.helpText as string | undefined,
  };

  switch (field._tag) {
    case "TextField":
      return {
        ...base,
        minLength: field.minLength as number | undefined,
        maxLength: field.maxLength as number | undefined,
        pattern: field.pattern as string | undefined,
      };
    case "LongTextField":
      return {
        ...base,
        rows: field.rows as number | undefined,
        minLength: field.minLength as number | undefined,
        maxLength: field.maxLength as number | undefined,
      };
    case "NumberField":
    case "IntegerField":
      return {
        ...base,
        min: field.min as number | undefined,
        max: field.max as number | undefined,
      };
    case "SelectField":
      return { ...base, options: field.options as string[] | undefined };
    case "MultiSelectField":
      return {
        ...base,
        options: field.options as string[] | undefined,
        minItems: field.minItems as number | undefined,
        maxItems: field.maxItems as number | undefined,
      };
    case "ReferenceField":
      return {
        ...base,
        relationCollection: field.collection as string | undefined,
        relationMultiple: field.multiple as boolean | undefined,
      };
    case "JsonField":
      return { ...base, rows: field.rows as number | undefined };
    case "SlugField":
      return {
        ...base,
        from: field.from as string | undefined,
        pattern: field.pattern as string | undefined,
      };
    case "ImageField":
    case "AudioField":
    case "VideoField":
    case "FileField":
      return { ...base, maxSize: field.maxSize as number | undefined };
    case "RepeaterField":
      return {
        ...base,
        nestedFields: [...(field.fields as CollectionFieldEntry[])],
        minItems: field.minItems as number | undefined,
        maxItems: field.maxItems as number | undefined,
      };
    default:
      return base;
  }
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

function validateFieldShape(field: unknown, path: string): string[] {
  if (!field || typeof field !== "object" || Array.isArray(field)) {
    return [`${path}.field must be an object.`];
  }

  const record = field as Record<string, unknown>;
  const tag = record._tag;
  if (typeof tag !== "string" || !VALID_COLLECTION_FIELD_TAGS.has(tag)) {
    return [`${path}.field._tag must be a supported field type.`];
  }
  if (typeof record.label !== "string") {
    return [`${path}.field.label must be a string.`];
  }
  if (typeof record.required !== "boolean") {
    return [`${path}.field.required must be a boolean.`];
  }

  const issues: string[] = [];
  if (tag === "RepeaterField") {
    if (!Array.isArray(record.fields)) {
      issues.push(`${path}.field.fields must be an array.`);
    } else {
      for (let index = 0; index < record.fields.length; index += 1) {
        issues.push(
          ...validateCollectionFieldEntry(record.fields[index], `${path}.field.fields[${index}]`),
        );
      }
    }
  }

  return issues;
}

function validateCollectionFieldEntry(entry: unknown, path: string): string[] {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return [`${path} must be an object.`];
  }

  const record = entry as Record<string, unknown>;
  const issues: string[] = [];
  if (typeof record.name !== "string" || record.name.trim().length === 0) {
    issues.push(`${path}.name must be a non-empty string.`);
  } else {
    const nameIssue = validateCollectionFieldName(record.name);
    if (nameIssue) {
      issues.push(`${path}.name ${nameIssue}`);
    }
  }

  issues.push(...validateFieldShape(record.field, path));
  return issues;
}

export function parseCollectionFieldEntriesJson(value: string): CollectionFieldEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Schema JSON must be valid JSON.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Schema JSON must be an array of field entries.");
  }

  const issues: string[] = [];
  const names = new Set<string>();
  for (let index = 0; index < parsed.length; index += 1) {
    const path = `[${index}]`;
    issues.push(...validateCollectionFieldEntry(parsed[index], path));
    const name = (parsed[index] as { name?: unknown })?.name;
    if (typeof name === "string") {
      if (names.has(name)) {
        issues.push(`Duplicate field name "${name}".`);
      }
      names.add(name);
    }
  }

  if (issues.length > 0) {
    throw new Error(issues.join("\n"));
  }

  return parsed as CollectionFieldEntry[];
}

// ─── Form value helpers (used by entry editor) ────────────────────────────────

export function initializeFieldDraftValue(
  definition: ContentSchemaDefinition,
  value: unknown,
): unknown {
  if (value === undefined || value === null) {
    if (definition.type === "boolean") return false;
    if (isMultiSelectSchemaField(definition) || isRepeaterSchemaField(definition)) return [];
    if (isReferenceSchemaField(definition)) {
      return isReferenceMultiple(definition) ? [] : undefined;
    }
    return "";
  }

  if (definition.type === "boolean") {
    return Boolean(value);
  }

  if (isReferenceSchemaField(definition)) {
    const collection = getReferenceCollection(definition) ?? "";
    if (isReferenceMultiple(definition)) {
      return Array.isArray(value) ? value : [];
    }
    if (typeof value === "object" && value && "id" in value) {
      return value;
    }
    if (typeof value === "string" && value.length > 0) {
      return { collection, id: value };
    }
    return undefined;
  }

  if (isMultiSelectSchemaField(definition) || isRepeaterSchemaField(definition)) {
    return Array.isArray(value) ? value : [];
  }

  return stringifySchemaFieldValue(definition, value);
}

export function createPreviewFieldValue(definition: ContentSchemaDefinition): unknown {
  if (definition.type === "boolean") return false;
  if (isMultiSelectSchemaField(definition) || isRepeaterSchemaField(definition)) return [];
  if (isReferenceSchemaField(definition)) {
    return isReferenceMultiple(definition) ? [] : undefined;
  }
  if (definition.type === "number" || definition.type === "integer") return "";
  return "";
}

// ─── Form value helpers (used by entry editor) ────────────────────────────────

export function normalizeSchemaFieldValue(
  definition: ContentSchemaDefinition,
  rawValue: unknown,
): unknown {
  if (rawValue === undefined) return undefined;

  if (isReferenceSchemaField(definition)) {
    const collection = getReferenceCollection(definition) ?? "";
    if (isReferenceMultiple(definition)) {
      if (!Array.isArray(rawValue)) return [];
      return rawValue
        .filter((item) => typeof item === "object" && item && "id" in item)
        .map((item) => ({
          collection:
            typeof (item as { collection?: unknown }).collection === "string"
              ? (item as { collection: string }).collection
              : collection,
          id: String((item as { id: unknown }).id),
        }));
    }
    if (typeof rawValue === "object" && rawValue && "id" in rawValue) {
      const record = rawValue as { collection?: unknown; id: unknown };
      return {
        collection: typeof record.collection === "string" ? record.collection : collection,
        id: String(record.id),
      };
    }
    if (typeof rawValue === "string" && rawValue.length > 0) {
      return { collection, id: rawValue };
    }
    return undefined;
  }

  if (isMultiSelectSchemaField(definition)) {
    return Array.isArray(rawValue) ? rawValue : [];
  }

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
