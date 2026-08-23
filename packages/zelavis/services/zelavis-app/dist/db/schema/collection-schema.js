import { Schema, SchemaIssue } from "effect";
import { CollectionFieldEntrySchema, } from "./field-types.js";
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
function formatIssuePath(path) {
    return path.length === 0 ? "$" : `$.${path.map(String).join(".")}`;
}
function formatSchemaIssues(issue) {
    const formatted = SchemaIssue.makeFormatterStandardSchemaV1()(issue);
    return formatted.issues.map((i) => ({
        path: formatIssuePath(i.path),
        message: i.message,
    }));
}
// ─── Field → value schema ──────────────────────────────────────────────────
function isFileField(field) {
    return (field._tag === "ImageField" ||
        field._tag === "AudioField" ||
        field._tag === "VideoField" ||
        field._tag === "FileField");
}
function addStringConstraints(schema, field) {
    let s = schema;
    if (field.minLength !== undefined) {
        const minLength = field.minLength;
        s = s.check(Schema.makeFilter((value) => value.length >= minLength ? undefined : `must be at least ${minLength} characters`, { title: `minLength(${minLength})` }));
    }
    if (field.maxLength !== undefined) {
        const maxLength = field.maxLength;
        s = s.check(Schema.makeFilter((value) => value.length <= maxLength ? undefined : `must be at most ${maxLength} characters`, { title: `maxLength(${maxLength})` }));
    }
    if (field.pattern) {
        const pattern = new RegExp(field.pattern);
        s = s.check(Schema.makeFilter((value) => pattern.test(value) ? undefined : "does not match the required pattern", { title: "pattern" }));
    }
    return s;
}
function addNumberConstraints(schema, field) {
    let s = schema;
    if (field.min !== undefined) {
        const min = field.min;
        s = s.check(Schema.makeFilter((n) => n >= min ? undefined : `must be >= ${min}`, { title: `min(${min})` }));
    }
    if (field.max !== undefined) {
        const max = field.max;
        s = s.check(Schema.makeFilter((n) => n <= max ? undefined : `must be <= ${max}`, { title: `max(${max})` }));
    }
    if (field.integer) {
        s = s.check(Schema.makeFilter((n) => Number.isInteger(n) ? undefined : "must be an integer", { title: "integer" }));
    }
    return s;
}
function addArrayLengthConstraints(schema, field) {
    let s = schema;
    if (field.minItems !== undefined) {
        const minItems = field.minItems;
        s = s.check(Schema.makeFilter((items) => items.length >= minItems ? undefined : `must contain at least ${minItems} items`, { title: `minItems(${minItems})` }));
    }
    if (field.maxItems !== undefined) {
        const maxItems = field.maxItems;
        s = s.check(Schema.makeFilter((items) => items.length <= maxItems ? undefined : `must contain at most ${maxItems} items`, { title: `maxItems(${maxItems})` }));
    }
    return s;
}
function optionSchema(options) {
    let s = Schema.String;
    if (options.length > 0) {
        s = s.check(Schema.makeFilter((value) => options.includes(value) ? undefined : `must be one of: ${options.join(", ")}`, { title: "options" }));
    }
    return s;
}
function fieldToValueSchema(field) {
    if (field._tag === "TextField" ||
        field._tag === "LongTextField") {
        return addStringConstraints(Schema.String, field);
    }
    if (field._tag === "RichTextField") {
        return Schema.String;
    }
    if (field._tag === "NumberField") {
        return addNumberConstraints(Schema.Number, field);
    }
    if (field._tag === "IntegerField") {
        return addNumberConstraints(Schema.Number, { ...field, integer: true });
    }
    if (field._tag === "BooleanField") {
        return Schema.Boolean;
    }
    if (field._tag === "DateTimeField") {
        let s = Schema.String;
        if (field.min !== undefined) {
            const min = Date.parse(field.min);
            s = s.check(Schema.makeFilter((value) => {
                const timestamp = Date.parse(value);
                return Number.isFinite(timestamp) && timestamp >= min
                    ? undefined
                    : `must be on or after ${field.min}`;
            }, { title: "minDateTime" }));
        }
        if (field.max !== undefined) {
            const max = Date.parse(field.max);
            s = s.check(Schema.makeFilter((value) => {
                const timestamp = Date.parse(value);
                return Number.isFinite(timestamp) && timestamp <= max
                    ? undefined
                    : `must be on or before ${field.max}`;
            }, { title: "maxDateTime" }));
        }
        return s.check(Schema.makeFilter((value) => Number.isFinite(Date.parse(value)) ? undefined : "must be a date-time string", { title: "dateTime" }));
    }
    if (field._tag === "SelectField") {
        return optionSchema(field.options);
    }
    if (field._tag === "MultiSelectField") {
        return addArrayLengthConstraints(Schema.Array(optionSchema(field.options)), field);
    }
    if (isFileField(field)) {
        let s = FileReferenceSchema;
        const accept = field.accept;
        if (accept && accept.length > 0) {
            s = s.check(Schema.makeFilter((ref) => {
                if (!ref.contentType)
                    return undefined;
                const matches = accept.some((pattern) => pattern.endsWith("/*")
                    ? ref.contentType.startsWith(pattern.slice(0, -1))
                    : ref.contentType === pattern);
                return matches
                    ? undefined
                    : `content type must be one of: ${accept.join(", ")}`;
            }, { title: "accept" }));
        }
        return s;
    }
    if (field._tag === "ReferenceField") {
        const singleReference = Schema.Struct({
            collection: Schema.String,
            id: Schema.String,
        }).check(Schema.makeFilter((ref) => ref.collection === field.collection
            ? undefined
            : `collection must be "${field.collection}"`, { title: "referenceCollection" }));
        return field.multiple
            ? Schema.Array(singleReference)
            : singleReference;
    }
    if (field._tag === "JsonField") {
        return Schema.Unknown;
    }
    if (field._tag === "SlugField") {
        return addStringConstraints(Schema.String, {
            ...field,
            pattern: field.pattern ?? "^[a-z0-9]+(?:-[a-z0-9]+)*$",
        });
    }
    if (field._tag === "UrlField") {
        return Schema.String.check(Schema.makeFilter((value) => {
            try {
                new URL(value);
                return undefined;
            }
            catch {
                return "must be a URL";
            }
        }, { title: "url" }));
    }
    if (field._tag === "RepeaterField") {
        const nestedShape = {};
        for (const { name, field: nestedField } of field.fields) {
            const nestedSchema = fieldToValueSchema(nestedField);
            nestedShape[name] = nestedField.required
                ? nestedSchema
                : Schema.optionalKey(nestedSchema);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return addArrayLengthConstraints(Schema.Array(Schema.Struct(nestedShape)), field);
    }
    return Schema.Unknown;
}
// ─── Document data validator ───────────────────────────────────────────────
export function validateDocumentData(fields, data) {
    const allIssues = [];
    // Check for unknown keys separately so field errors are always collected too
    const knownKeys = new Set(fields.map((f) => f.name));
    for (const key of Object.keys(data)) {
        if (!knownKeys.has(key)) {
            allIssues.push({ path: `$.${key}`, message: "is not allowed" });
        }
    }
    // Build struct schema and validate the known fields (no onExcessProperty — already handled above)
    const shape = {};
    for (const { name, field } of fields) {
        const valueSchema = fieldToValueSchema(field);
        shape[name] = field.required
            ? valueSchema
            : Schema.optionalKey(valueSchema);
    }
    const structSchema = Schema.Struct(shape);
    const result = Schema.decodeUnknownResult(structSchema)(data, { errors: "all" });
    if (result._tag === "Failure") {
        allIssues.push(...formatSchemaIssues(result.failure.issue));
    }
    return { valid: allIssues.length === 0, issues: allIssues };
}
