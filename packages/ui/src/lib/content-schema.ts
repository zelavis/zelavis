export type ContentSchemaControl = "text" | "textarea" | "rich-text";
export type ContentSchemaEditor = "lexical";
export type ContentFieldBuilderKind =
  | "text"
  | "long-text"
  | "rich-text"
  | "number"
  | "boolean"
  | "status"
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

export function getContentSchemaProperties(
  document: unknown,
): Record<string, ContentSchemaDefinition> {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return {};
  }

  if (!("properties" in document)) {
    return {};
  }

  const properties = (document as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return {};
  }

  return properties as Record<string, ContentSchemaDefinition>;
}

export function getContentSchemaFields(document: unknown): ContentSchemaField[] {
  const properties = getContentSchemaProperties(document);
  const required = Array.isArray((document as { required?: unknown }).required)
    ? ((document as { required: unknown[] }).required.filter(
        (value): value is string => typeof value === "string",
      ) as string[])
    : [];

  return Object.entries(properties).map(([name, definition]) => ({
    name,
    label:
      typeof definition.label === "string" && definition.label.trim().length > 0
        ? definition.label
        : humanizeFieldName(name),
    description:
      typeof definition.description === "string" ? definition.description : undefined,
    required: required.includes(name),
    definition,
  }));
}

export function isRichTextSchemaField(
  name: string,
  definition: ContentSchemaDefinition,
): boolean {
  if (definition.type !== "string") {
    return false;
  }

  const ui = getContentSchemaUi(definition);
  return (
    ui?.control === "rich-text" ||
    (typeof definition.format === "string" && definition.format === "html") ||
    name === "_content"
  );
}

export function createStarterContentTypeSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["title", "slug"],
    properties: {
      title: {
        type: "string",
        minLength: 1,
        label: "Title",
      },
      slug: {
        type: "string",
        minLength: 1,
        label: "Slug",
        description: "Stable URL segment for this entry.",
      },
      excerpt: {
        type: "string",
        label: "Excerpt",
        ui: {
          control: "textarea",
          rows: 4,
          placeholder: "Short summary for cards, listings, and previews.",
        },
      },
      _content: {
        type: "string",
        format: "html",
        label: "Content",
        description: "Primary rich-text body for this content type.",
        ui: {
          control: "rich-text",
          editor: "lexical",
          placeholder: "Start writing...",
        },
      },
      status: {
        type: "string",
        label: "Status",
        enum: ["draft", "review", "published"],
      },
    },
  };
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

function createFileFieldDefinition(kind: Extract<ContentFieldBuilderKind, "file" | "image" | "audio" | "video" | "document">): ContentSchemaDefinition {
  switch (kind) {
    case "image":
      return {
        type: "file",
        label: "Image",
        mimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
        maxSize: 5_000_000,
      };
    case "audio":
      return {
        type: "file",
        label: "Audio",
        mimeTypes: ["audio/mpeg", "audio/wav", "audio/ogg", "audio/webm"],
        maxSize: 20_000_000,
      };
    case "video":
      return {
        type: "file",
        label: "Video",
        mimeTypes: ["video/mp4", "video/webm", "video/ogg", "video/quicktime"],
        maxSize: 50_000_000,
      };
    case "document":
      return {
        type: "file",
        label: "Document",
        mimeTypes: [
          "application/pdf",
          "text/plain",
          "application/json",
          "application/zip",
        ],
        maxSize: 10_000_000,
      };
    case "file":
    default:
      return {
        type: "file",
      };
  }
}

export function createContentFieldDefinition(
  input: ContentFieldBuilderInput,
): ContentSchemaDefinition {
  const shared = {
    ...(input.label?.trim() ? { label: input.label.trim() } : {}),
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
  };

  switch (input.kind) {
    case "text":
      return {
        type: "string",
        ...shared,
      };
    case "long-text":
      return {
        type: "string",
        ...shared,
        ui: {
          control: "textarea",
          rows: 5,
        },
      };
    case "rich-text":
      return {
        type: "string",
        format: "html",
        ...shared,
        ui: {
          control: "rich-text",
          editor: "lexical",
          placeholder: "Start writing...",
        },
      };
    case "number":
      return {
        type: "number",
        ...shared,
      };
    case "boolean":
      return {
        type: "boolean",
        ...shared,
      };
    case "status":
      return {
        type: "string",
        ...shared,
        enum: ["draft", "review", "published"],
      };
    case "json":
      return {
        type: "object",
        ...shared,
      };
    case "file":
    case "image":
    case "audio":
    case "video":
    case "document":
      return {
        ...createFileFieldDefinition(input.kind),
        ...shared,
      };
    default:
      return {
        type: "string",
        ...shared,
      };
  }
}

export function insertFieldIntoSchemaDocument(input: {
  document: Record<string, unknown>;
  field: ContentFieldBuilderInput;
}): Record<string, unknown> {
  const nextDocument = structuredClone(input.document) as Record<string, unknown>;
  if (nextDocument.type !== "object") {
    throw new Error("The schema root must be an object.");
  }

  const fieldName = input.field.name.trim();
  if (!fieldName) {
    throw new Error("A field name is required.");
  }

  const properties =
    nextDocument.properties && typeof nextDocument.properties === "object"
      ? ({ ...(nextDocument.properties as Record<string, unknown>) })
      : {};

  if (fieldName in properties) {
    throw new Error(`A field named "${fieldName}" already exists.`);
  }

  properties[fieldName] = createContentFieldDefinition(input.field);
  nextDocument.properties = properties;

  const required = Array.isArray(nextDocument.required)
    ? (nextDocument.required.filter(
        (value): value is string => typeof value === "string",
      ) as string[])
    : [];

  nextDocument.required = input.field.required
    ? [...new Set([...required, fieldName])]
    : required.filter((value) => value !== fieldName);

  return nextDocument;
}

export function removeFieldFromSchemaDocument(input: {
  document: Record<string, unknown>;
  fieldName: string;
}): Record<string, unknown> {
  const nextDocument = structuredClone(input.document) as Record<string, unknown>;
  const properties =
    nextDocument.properties && typeof nextDocument.properties === "object"
      ? ({ ...(nextDocument.properties as Record<string, unknown>) })
      : {};

  delete properties[input.fieldName];
  nextDocument.properties = properties;

  const required = Array.isArray(nextDocument.required)
    ? (nextDocument.required.filter(
        (value): value is string => typeof value === "string",
      ) as string[])
    : [];

  nextDocument.required = required.filter((value) => value !== input.fieldName);
  return nextDocument;
}

export function normalizeSchemaFieldValue(
  definition: ContentSchemaDefinition,
  rawValue: unknown,
): unknown {
  if (rawValue === undefined) {
    return undefined;
  }

  switch (definition.type) {
    case "number": {
      if (rawValue === "" || rawValue === null) {
        return undefined;
      }
      const numeric = Number(rawValue);
      return Number.isFinite(numeric) ? numeric : rawValue;
    }
    case "boolean":
      return Boolean(rawValue);
    case "object":
    case "array":
    case "file":
      if (typeof rawValue !== "string") {
        return rawValue;
      }
      if (rawValue.trim().length === 0) {
        return undefined;
      }
      return JSON.parse(rawValue) as unknown;
    default:
      return rawValue;
  }
}

export function stringifySchemaFieldValue(
  definition: ContentSchemaDefinition,
  value: unknown,
): string {
  if (value === undefined || value === null) {
    return "";
  }

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
