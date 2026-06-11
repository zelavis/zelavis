import { Schema } from "effect";
import type { DatabaseJsonObject } from "../contracts/json.js";
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

// ─── Issue flattening ──────────────────────────────────────────────────────

function formatIssuePath(path: ReadonlyArray<string | number>): string {
  return path.length === 0 ? "$" : `$.${path.map(String).join(".")}`;
}

function flattenIssue(
  issue: Record<string, unknown>,
  path: ReadonlyArray<string | number> = [],
): SchemaValidationIssue[] {
  switch (issue._tag) {
    case "Composite": {
      const issues = issue.issues as Array<Record<string, unknown>>;
      return issues.flatMap((i) => flattenIssue(i, path));
    }
    case "Pointer": {
      const issuePath = issue.path as Array<string | number>;
      return flattenIssue(
        issue.issue as Record<string, unknown>,
        [...path, ...issuePath],
      );
    }
    case "MissingKey":
      return [{ path: formatIssuePath(path), message: "is required" }];
    case "UnexpectedKey":
      return [{ path: formatIssuePath(path), message: "is not allowed" }];
    case "InvalidType": {
      const ast = issue.ast as Record<string, unknown> | undefined;
      const typeName = (ast?._tag as string | undefined)?.toLowerCase() ?? "valid";
      return [{ path: formatIssuePath(path), message: `must be a ${typeName}` }];
    }
    case "Filter":
      return flattenIssue(issue.issue as Record<string, unknown>, path);
    case "InvalidValue": {
      const annotations = issue.annotations as Record<string, unknown> | undefined;
      const msg = annotations?.message ?? "is invalid";
      return [{ path: formatIssuePath(path), message: String(msg) }];
    }
    default:
      return [{ path: formatIssuePath(path), message: "is invalid" }];
  }
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

function fieldToValueSchema(field: CollectionField): Schema.Schema<unknown> {
  if (field._tag === "TextField" || field._tag === "RichTextField") {
    return Schema.String as Schema.Schema<unknown>;
  }

  if (field._tag === "NumberField") {
    let s: Schema.Schema<unknown> = Schema.Number as Schema.Schema<unknown>;
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

  if (field._tag === "BooleanField") {
    return Schema.Boolean as Schema.Schema<unknown>;
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

  if (field._tag === "RepeaterField") {
    const nestedShape: Record<string, Schema.Schema<unknown>> = {};
    for (const { name, field: nestedField } of field.fields) {
      const nestedSchema = fieldToValueSchema(nestedField);
      nestedShape[name] = nestedField.required
        ? nestedSchema
        : (Schema.optionalKey(nestedSchema) as Schema.Schema<unknown>);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Schema.Array(Schema.Struct(nestedShape as any)) as Schema.Schema<unknown>;
  }

  return Schema.Unknown;
}

// ─── Document data validator ───────────────────────────────────────────────

export function validateDocumentData(
  fields: readonly CollectionFieldEntry[],
  data: DatabaseJsonObject,
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const structSchema = Schema.Struct(shape as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (Schema.decodeUnknownResult as any)(structSchema)(data);

  if (result._tag === "Failure") {
    const fieldIssues = flattenIssue(
      result.failure.issue as unknown as Record<string, unknown>,
    );
    allIssues.push(...fieldIssues);
  }

  return { valid: allIssues.length === 0, issues: allIssues };
}
