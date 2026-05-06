export type ContentSchemaControl = "text" | "textarea" | "rich-text";
export type ContentSchemaEditor = "lexical";

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
