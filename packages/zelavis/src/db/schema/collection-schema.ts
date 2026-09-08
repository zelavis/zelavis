import { Schema, SchemaIssue } from "effect";
import type { JsonObject } from "../json.js";
import {
  type CollectionField,
  type CollectionFieldEntry,
  CollectionFieldEntrySchema,
  FileFieldSchema,
  ImageFieldSchema,
  AudioFieldSchema,
  VideoFieldSchema,
} from "./field-types.js";

// ─── Public types ──────────────────────────────────────────────────────────

export interface CollectionSchema {
  collection: string;
  version: number;
  activate?: boolean;
  fields: readonly CollectionFieldEntry[];
}

export interface StoredCollectionSchema {
  collection: string;
  version: number;
  active: boolean;
  fields: readonly CollectionFieldEntry[];
}

export interface CollectionSchemaSummary {
  collection: string;
  activeVersion: number | null;
  versions: readonly number[];
}

export interface SchemaValidationIssue {
  path: string;
  message: string;
}

export interface SchemaValidationResult {
  schemaVersion: number;
  valid: boolean;
  issues: readonly SchemaValidationIssue[];
}

// ─── StoredCollectionSchema codec (for JSON persistence) ──────────────────

export const StoredCollectionSchemaCodec = Schema.Struct({
  collection: Schema.String,
  version: Schema.Number,
  active: Schema.Boolean,
  fields: Schema.Array(CollectionFieldEntrySchema),
});

// ─── File reference schema ─────────────────────────────────────────────────

const FileReferenceSchema = Schema.Struct({
  kind: Schema.Literal("file"),
  path: Schema.String,
  href: Schema.String,
  metadataHref: Schema.String,
  size: Schema.optionalKey(Schema.Number),
  updatedAt: Schema.optionalKey(Schema.String),
  contentType: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  checksum: Schema.optionalKey(Schema.String),
});

// ─── Issue formatting ──────────────────────────────────────────────────────

function formatIssuePath(path: ReadonlyArray<string | number>): string {
  return path.length === 0 ? "$" : `$.${path.map(String).join(".")}`;
}

function formatSchemaIssues(issue: SchemaIssue.Issue): SchemaValidationIssue[] {
  const formatted = SchemaIssue.makeFormatterStandardSchemaV1()(issue);
  return formatted.issues.map((i) => ({
    path: formatIssuePath(i.path as ReadonlyArray<string | number>),
    message: i.message,
  }));
}

// ─── Field → value schema ──────────────────────────────────────────────────

function isFileField(
  field: CollectionField,
): field is
  | Schema.Schema.Type<typeof ImageFieldSchema>
  | Schema.Schema.Type<typeof AudioFieldSchema>
  | Schema.Schema.Type<typeof VideoFieldSchema>
  | Schema.Schema.Type<typeof FileFieldSchema> {
  return (
    field._tag === "ImageField" ||
    field._tag === "AudioField" ||
    field._tag === "VideoField" ||
    field._tag === "FileField"
  );
}

function addStringConstraints(
  schema: Schema.Schema<string>,
  field: {
    minLength?: number;
    maxLength?: number;
    pattern?: string;
  },
): Schema.Schema<unknown> {
  let s: Schema.Schema<unknown> = schema as Schema.Schema<unknown>;
  if (field.minLength !== undefined) {
    const minLength = field.minLength;
    s = (s as Schema.Schema<string>).check(
      Schema.makeFilter(
        (value: string) =>
          value.length >= minLength ? undefined : `must be at least ${minLength} characters`,
        { title: `minLength(${minLength})` },
      ),
    ) as unknown as Schema.Schema<unknown>;
  }
  if (field.maxLength !== undefined) {
    const maxLength = field.maxLength;
    s = (s as Schema.Schema<string>).check(
      Schema.makeFilter(
        (value: string) =>
          value.length <= maxLength ? undefined : `must be at most ${maxLength} characters`,
        { title: `maxLength(${maxLength})` },
      ),
    ) as unknown as Schema.Schema<unknown>;
  }
  if (field.pattern) {
    const pattern = new RegExp(field.pattern);
    s = (s as Schema.Schema<string>).check(
      Schema.makeFilter(
        (value: string) =>
          pattern.test(value) ? undefined : "does not match the required pattern",
        { title: "pattern" },
      ),
    ) as unknown as Schema.Schema<unknown>;
  }
  return s;
}

function addNumberConstraints(
  schema: Schema.Schema<number>,
  field: { min?: number; max?: number; integer?: boolean },
): Schema.Schema<unknown> {
  let s: Schema.Schema<unknown> = schema as Schema.Schema<unknown>;
  if (field.min !== undefined) {
    const min = field.min;
    s = (s as Schema.Schema<number>).check(
      Schema.makeFilter(
        (n: number) =>
          n >= min ? undefined : `must be >= ${min}`,
        { title: `min(${min})` },
      ),
    ) as unknown as Schema.Schema<unknown>;
  }
  if (field.max !== undefined) {
    const max = field.max;
    s = (s as Schema.Schema<number>).check(
      Schema.makeFilter(
        (n: number) =>
          n <= max ? undefined : `must be <= ${max}`,
        { title: `max(${max})` },
      ),
    ) as unknown as Schema.Schema<unknown>;
  }
  if (field.integer) {
    s = (s as Schema.Schema<number>).check(
      Schema.makeFilter(
        (n: number) =>
          Number.isInteger(n) ? undefined : "must be an integer",
        { title: "integer" },
      ),
    ) as unknown as Schema.Schema<unknown>;
  }
  return s;
}

function addArrayLengthConstraints<T>(
  schema: Schema.Schema<readonly T[]>,
  field: { minItems?: number; maxItems?: number },
): Schema.Schema<unknown> {
  let s: Schema.Schema<unknown> = schema as Schema.Schema<unknown>;
  if (field.minItems !== undefined) {
    const minItems = field.minItems;
    s = (s as Schema.Schema<readonly T[]>).check(
      Schema.makeFilter(
        (items: readonly T[]) =>
          items.length >= minItems ? undefined : `must contain at least ${minItems} items`,
        { title: `minItems(${minItems})` },
      ),
    ) as unknown as Schema.Schema<unknown>;
  }
  if (field.maxItems !== undefined) {
    const maxItems = field.maxItems;
    s = (s as Schema.Schema<readonly T[]>).check(
      Schema.makeFilter(
        (items: readonly T[]) =>
          items.length <= maxItems ? undefined : `must contain at most ${maxItems} items`,
        { title: `maxItems(${maxItems})` },
      ),
    ) as unknown as Schema.Schema<unknown>;
  }
  return s;
}

function optionSchema(options: readonly string[]): Schema.Schema<unknown> {
  let s: Schema.Schema<unknown> = Schema.String as Schema.Schema<unknown>;
  if (options.length > 0) {
    s = (s as Schema.Schema<string>).check(
      Schema.makeFilter(
        (value: string) =>
          options.includes(value) ? undefined : `must be one of: ${options.join(", ")}`,
        { title: "options" },
      ),
    ) as unknown as Schema.Schema<unknown>;
  }
  return s;
}

function fieldToValueSchema(field: CollectionField): Schema.Schema<unknown> {
  if (
    field._tag === "TextField" ||
    field._tag === "LongTextField"
  ) {
    return addStringConstraints(Schema.String, field);
  }

  if (field._tag === "RichTextField") {
    return Schema.String as Schema.Schema<unknown>;
  }

  if (field._tag === "NumberField") {
    return addNumberConstraints(Schema.Number, field);
  }

  if (field._tag === "IntegerField") {
    return addNumberConstraints(Schema.Number, { ...field, integer: true });
  }

  if (field._tag === "BooleanField") {
    return Schema.Boolean as Schema.Schema<unknown>;
  }

  if (field._tag === "DateTimeField") {
    let s: Schema.Schema<unknown> = Schema.String as Schema.Schema<unknown>;
    if (field.min !== undefined) {
      const min = Date.parse(field.min);
      s = (s as Schema.Schema<string>).check(
        Schema.makeFilter(
          (value: string) => {
            const timestamp = Date.parse(value);
            return Number.isFinite(timestamp) && timestamp >= min
              ? undefined
              : `must be on or after ${field.min}`;
          },
          { title: "minDateTime" },
        ),
      ) as unknown as Schema.Schema<unknown>;
    }
    if (field.max !== undefined) {
      const max = Date.parse(field.max);
      s = (s as Schema.Schema<string>).check(
        Schema.makeFilter(
          (value: string) => {
            const timestamp = Date.parse(value);
            return Number.isFinite(timestamp) && timestamp <= max
              ? undefined
              : `must be on or before ${field.max}`;
          },
          { title: "maxDateTime" },
        ),
      ) as unknown as Schema.Schema<unknown>;
    }
    return (s as Schema.Schema<string>).check(
      Schema.makeFilter(
        (value: string) =>
          Number.isFinite(Date.parse(value)) ? undefined : "must be a date-time string",
        { title: "dateTime" },
      ),
    ) as unknown as Schema.Schema<unknown>;
  }

  if (field._tag === "SelectField") {
    return optionSchema(field.options);
  }

  if (field._tag === "MultiSelectField") {
    return addArrayLengthConstraints(
      Schema.Array(optionSchema(field.options)) as Schema.Schema<readonly unknown[]>,
      field,
    );
  }

  if (isFileField(field)) {
    let s: Schema.Schema<unknown> = FileReferenceSchema as Schema.Schema<unknown>;
    const accept = field.accept;
    if (accept && accept.length > 0) {
      s = (
        s as Schema.Schema<Schema.Schema.Type<typeof FileReferenceSchema>>
      ).check(
        Schema.makeFilter(
          (ref) => {
            if (!ref.contentType) return undefined;
            const matches = accept.some((pattern) =>
              pattern.endsWith("/*")
                ? ref.contentType!.startsWith(pattern.slice(0, -1))
                : ref.contentType === pattern,
            );
            return matches
              ? undefined
              : `content type must be one of: ${accept.join(", ")}`;
          },
          { title: "accept" },
        ),
      ) as unknown as Schema.Schema<unknown>;
    }
    return s;
  }

  if (field._tag === "ReferenceField") {
    const singleReference = Schema.Struct({
      collection: Schema.String,
      id: Schema.String,
    }).check(
      Schema.makeFilter(
        (ref) =>
          ref.collection === field.collection
            ? undefined
            : `collection must be "${field.collection}"`,
        { title: "referenceCollection" },
      ),
    ) as unknown as Schema.Schema<unknown>;
    return field.multiple
      ? Schema.Array(singleReference) as Schema.Schema<unknown>
      : singleReference;
  }

  if (field._tag === "JsonField") {
    return Schema.Unknown as Schema.Schema<unknown>;
  }

  if (field._tag === "SlugField") {
    return addStringConstraints(Schema.String, {
      ...field,
      pattern: field.pattern ?? "^[a-z0-9]+(?:-[a-z0-9]+)*$",
    });
  }

  if (field._tag === "UrlField") {
    return (Schema.String as Schema.Schema<string>).check(
      Schema.makeFilter(
        (value: string) => {
          try {
            new URL(value);
            return undefined;
          } catch {
            return "must be a URL";
          }
        },
        { title: "url" },
      ),
    ) as unknown as Schema.Schema<unknown>;
  }

  if (field._tag === "RepeaterField") {
    const nestedShape: Record<string, Schema.Schema<unknown>> = {};
    for (const { name, field: nestedField } of field.fields) {
      const nestedSchema = fieldToValueSchema(nestedField);
      nestedShape[name] = nestedField.required
        ? nestedSchema
        : (Schema.optionalKey(nestedSchema) as Schema.Schema<unknown>);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return addArrayLengthConstraints(
      Schema.Array(Schema.Struct(nestedShape as any)) as Schema.Schema<readonly unknown[]>,
      field,
    );
  }

  return Schema.Unknown;
}

// ─── Document data validator ───────────────────────────────────────────────

export function validateDocumentData(
  fields: readonly CollectionFieldEntry[],
  data: JsonObject,
): { valid: boolean; issues: readonly SchemaValidationIssue[] } {
  const allIssues: SchemaValidationIssue[] = [];

  // Check for unknown keys separately so field errors are always collected too
  const knownKeys = new Set(fields.map((f) => f.name));
  for (const key of Object.keys(data)) {
    if (!knownKeys.has(key)) {
      allIssues.push({ path: `$.${key}`, message: "is not allowed" });
    }
  }

  // Build struct schema and validate the known fields (no onExcessProperty — already handled above)
  const shape: Record<string, Schema.Schema<unknown>> = {};
  for (const { name, field } of fields) {
    const valueSchema = fieldToValueSchema(field);
    shape[name] = field.required
      ? valueSchema
      : (Schema.optionalKey(valueSchema) as Schema.Schema<unknown>);
  }

  const structSchema = Schema.Struct(shape as any) as unknown as Schema.ConstraintDecoder<unknown>;
  const result = Schema.decodeUnknownResult(structSchema)(data, { errors: "all" });

  if (result._tag === "Failure") {
    allIssues.push(...formatSchemaIssues(result.failure.issue));
  }

  return { valid: allIssues.length === 0, issues: allIssues };
}
