import { Schema } from "effect";
// ─── Leaf field definitions ─────────────────────────────────────────────────
export const TextFieldSchema = Schema.TaggedStruct("TextField", {
    label: Schema.String,
    required: Schema.Boolean,
    description: Schema.optionalKey(Schema.String),
    placeholder: Schema.optionalKey(Schema.String),
    helpText: Schema.optionalKey(Schema.String),
    group: Schema.optionalKey(Schema.String),
    minLength: Schema.optionalKey(Schema.Number),
    maxLength: Schema.optionalKey(Schema.Number),
    pattern: Schema.optionalKey(Schema.String),
});
export const LongTextFieldSchema = Schema.TaggedStruct("LongTextField", {
    label: Schema.String,
    required: Schema.Boolean,
    description: Schema.optionalKey(Schema.String),
    placeholder: Schema.optionalKey(Schema.String),
    helpText: Schema.optionalKey(Schema.String),
    group: Schema.optionalKey(Schema.String),
    rows: Schema.optionalKey(Schema.Number),
    minLength: Schema.optionalKey(Schema.Number),
    maxLength: Schema.optionalKey(Schema.Number),
});
export const RichTextFieldSchema = Schema.TaggedStruct("RichTextField", {
    label: Schema.String,
    required: Schema.Boolean,
    description: Schema.optionalKey(Schema.String),
    placeholder: Schema.optionalKey(Schema.String),
    helpText: Schema.optionalKey(Schema.String),
    group: Schema.optionalKey(Schema.String),
});
export const NumberFieldSchema = Schema.TaggedStruct("NumberField", {
    label: Schema.String,
    required: Schema.Boolean,
    description: Schema.optionalKey(Schema.String),
    placeholder: Schema.optionalKey(Schema.String),
    helpText: Schema.optionalKey(Schema.String),
    group: Schema.optionalKey(Schema.String),
    min: Schema.optionalKey(Schema.Number),
    max: Schema.optionalKey(Schema.Number),
    integer: Schema.optionalKey(Schema.Boolean),
});
export const IntegerFieldSchema = Schema.TaggedStruct("IntegerField", {
    label: Schema.String,
    required: Schema.Boolean,
    description: Schema.optionalKey(Schema.String),
    placeholder: Schema.optionalKey(Schema.String),
    helpText: Schema.optionalKey(Schema.String),
    group: Schema.optionalKey(Schema.String),
    min: Schema.optionalKey(Schema.Number),
    max: Schema.optionalKey(Schema.Number),
});
export const BooleanFieldSchema = Schema.TaggedStruct("BooleanField", {
    label: Schema.String,
    required: Schema.Boolean,
    description: Schema.optionalKey(Schema.String),
    helpText: Schema.optionalKey(Schema.String),
    group: Schema.optionalKey(Schema.String),
});
export const DateTimeFieldSchema = Schema.TaggedStruct("DateTimeField", {
    label: Schema.String,
    required: Schema.Boolean,
    description: Schema.optionalKey(Schema.String),
    helpText: Schema.optionalKey(Schema.String),
    group: Schema.optionalKey(Schema.String),
    min: Schema.optionalKey(Schema.String),
    max: Schema.optionalKey(Schema.String),
});
export const SelectFieldSchema = Schema.TaggedStruct("SelectField", {
    label: Schema.String,
    required: Schema.Boolean,
    description: Schema.optionalKey(Schema.String),
    placeholder: Schema.optionalKey(Schema.String),
    helpText: Schema.optionalKey(Schema.String),
    group: Schema.optionalKey(Schema.String),
    options: Schema.Array(Schema.String),
});
export const MultiSelectFieldSchema = Schema.TaggedStruct("MultiSelectField", {
    label: Schema.String,
    required: Schema.Boolean,
    description: Schema.optionalKey(Schema.String),
    placeholder: Schema.optionalKey(Schema.String),
    helpText: Schema.optionalKey(Schema.String),
    group: Schema.optionalKey(Schema.String),
    options: Schema.Array(Schema.String),
    minItems: Schema.optionalKey(Schema.Number),
    maxItems: Schema.optionalKey(Schema.Number),
});
export const ImageFieldSchema = Schema.TaggedStruct("ImageField", {
    label: Schema.String,
    required: Schema.Boolean,
    description: Schema.optionalKey(Schema.String),
    helpText: Schema.optionalKey(Schema.String),
    group: Schema.optionalKey(Schema.String),
    accept: Schema.optionalKey(Schema.Array(Schema.String)),
    maxSize: Schema.optionalKey(Schema.Number),
});
export const AudioFieldSchema = Schema.TaggedStruct("AudioField", {
    label: Schema.String,
    required: Schema.Boolean,
    description: Schema.optionalKey(Schema.String),
    helpText: Schema.optionalKey(Schema.String),
    group: Schema.optionalKey(Schema.String),
    accept: Schema.optionalKey(Schema.Array(Schema.String)),
    maxSize: Schema.optionalKey(Schema.Number),
});
export const VideoFieldSchema = Schema.TaggedStruct("VideoField", {
    label: Schema.String,
    required: Schema.Boolean,
    description: Schema.optionalKey(Schema.String),
    helpText: Schema.optionalKey(Schema.String),
    group: Schema.optionalKey(Schema.String),
    accept: Schema.optionalKey(Schema.Array(Schema.String)),
    maxSize: Schema.optionalKey(Schema.Number),
});
export const FileFieldSchema = Schema.TaggedStruct("FileField", {
    label: Schema.String,
    required: Schema.Boolean,
    description: Schema.optionalKey(Schema.String),
    helpText: Schema.optionalKey(Schema.String),
    group: Schema.optionalKey(Schema.String),
    accept: Schema.optionalKey(Schema.Array(Schema.String)),
    maxSize: Schema.optionalKey(Schema.Number),
});
export const ReferenceFieldSchema = Schema.TaggedStruct("ReferenceField", {
    label: Schema.String,
    required: Schema.Boolean,
    description: Schema.optionalKey(Schema.String),
    helpText: Schema.optionalKey(Schema.String),
    group: Schema.optionalKey(Schema.String),
    collection: Schema.String,
    multiple: Schema.optionalKey(Schema.Boolean),
});
export const JsonFieldSchema = Schema.TaggedStruct("JsonField", {
    label: Schema.String,
    required: Schema.Boolean,
    description: Schema.optionalKey(Schema.String),
    placeholder: Schema.optionalKey(Schema.String),
    helpText: Schema.optionalKey(Schema.String),
    group: Schema.optionalKey(Schema.String),
    rows: Schema.optionalKey(Schema.Number),
});
export const SlugFieldSchema = Schema.TaggedStruct("SlugField", {
    label: Schema.String,
    required: Schema.Boolean,
    description: Schema.optionalKey(Schema.String),
    placeholder: Schema.optionalKey(Schema.String),
    helpText: Schema.optionalKey(Schema.String),
    group: Schema.optionalKey(Schema.String),
    from: Schema.optionalKey(Schema.String),
    pattern: Schema.optionalKey(Schema.String),
});
export const UrlFieldSchema = Schema.TaggedStruct("UrlField", {
    label: Schema.String,
    required: Schema.Boolean,
    description: Schema.optionalKey(Schema.String),
    placeholder: Schema.optionalKey(Schema.String),
    helpText: Schema.optionalKey(Schema.String),
    group: Schema.optionalKey(Schema.String),
});
// ─── Recursive schemas ────────────────────────────────────────────────────────
export const CollectionFieldEntrySchema = Schema.Struct({
    name: Schema.String,
    field: Schema.suspend(() => CollectionFieldSchema),
});
export const RepeaterFieldSchema = Schema.TaggedStruct("RepeaterField", {
    label: Schema.String,
    required: Schema.Boolean,
    description: Schema.optionalKey(Schema.String),
    helpText: Schema.optionalKey(Schema.String),
    group: Schema.optionalKey(Schema.String),
    fields: Schema.Array(CollectionFieldEntrySchema),
    minItems: Schema.optionalKey(Schema.Number),
    maxItems: Schema.optionalKey(Schema.Number),
});
export const CollectionFieldSchema = Schema.Union([
    TextFieldSchema,
    LongTextFieldSchema,
    RichTextFieldSchema,
    NumberFieldSchema,
    IntegerFieldSchema,
    BooleanFieldSchema,
    DateTimeFieldSchema,
    SelectFieldSchema,
    MultiSelectFieldSchema,
    ImageFieldSchema,
    AudioFieldSchema,
    VideoFieldSchema,
    FileFieldSchema,
    ReferenceFieldSchema,
    JsonFieldSchema,
    SlugFieldSchema,
    UrlFieldSchema,
    RepeaterFieldSchema,
]);
