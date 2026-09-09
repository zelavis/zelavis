import { Schema } from "effect";

// ─── Leaf field definitions ─────────────────────────────────────────────────

export const TextFieldSchema = Schema.TaggedStruct("TextField", {
  label: Schema.String,
  required: Schema.Boolean,
  description: Schema.optionalKey(Schema.String),
  placeholder: Schema.optionalKey(Schema.String),
  helpText: Schema.optionalKey(Schema.String),
  group: Schema.optionalKey(Schema.String),
  minLength: Schema.optionalKey(Schema.Finite),
  maxLength: Schema.optionalKey(Schema.Finite),
  pattern: Schema.optionalKey(Schema.String),
});
export type TextField = Schema.Schema.Type<typeof TextFieldSchema>;

export const LongTextFieldSchema = Schema.TaggedStruct("LongTextField", {
  label: Schema.String,
  required: Schema.Boolean,
  description: Schema.optionalKey(Schema.String),
  placeholder: Schema.optionalKey(Schema.String),
  helpText: Schema.optionalKey(Schema.String),
  group: Schema.optionalKey(Schema.String),
  rows: Schema.optionalKey(Schema.Finite),
  minLength: Schema.optionalKey(Schema.Finite),
  maxLength: Schema.optionalKey(Schema.Finite),
});
export type LongTextField = Schema.Schema.Type<typeof LongTextFieldSchema>;

export const RichTextFieldSchema = Schema.TaggedStruct("RichTextField", {
  label: Schema.String,
  required: Schema.Boolean,
  description: Schema.optionalKey(Schema.String),
  placeholder: Schema.optionalKey(Schema.String),
  helpText: Schema.optionalKey(Schema.String),
  group: Schema.optionalKey(Schema.String),
});
export type RichTextField = Schema.Schema.Type<typeof RichTextFieldSchema>;

export const NumberFieldSchema = Schema.TaggedStruct("NumberField", {
  label: Schema.String,
  required: Schema.Boolean,
  description: Schema.optionalKey(Schema.String),
  placeholder: Schema.optionalKey(Schema.String),
  helpText: Schema.optionalKey(Schema.String),
  group: Schema.optionalKey(Schema.String),
  min: Schema.optionalKey(Schema.Finite),
  max: Schema.optionalKey(Schema.Finite),
  integer: Schema.optionalKey(Schema.Boolean),
});
export type NumberField = Schema.Schema.Type<typeof NumberFieldSchema>;

export const IntegerFieldSchema = Schema.TaggedStruct("IntegerField", {
  label: Schema.String,
  required: Schema.Boolean,
  description: Schema.optionalKey(Schema.String),
  placeholder: Schema.optionalKey(Schema.String),
  helpText: Schema.optionalKey(Schema.String),
  group: Schema.optionalKey(Schema.String),
  min: Schema.optionalKey(Schema.Finite),
  max: Schema.optionalKey(Schema.Finite),
});
export type IntegerField = Schema.Schema.Type<typeof IntegerFieldSchema>;

export const BooleanFieldSchema = Schema.TaggedStruct("BooleanField", {
  label: Schema.String,
  required: Schema.Boolean,
  description: Schema.optionalKey(Schema.String),
  helpText: Schema.optionalKey(Schema.String),
  group: Schema.optionalKey(Schema.String),
});
export type BooleanField = Schema.Schema.Type<typeof BooleanFieldSchema>;

export const DateTimeFieldSchema = Schema.TaggedStruct("DateTimeField", {
  label: Schema.String,
  required: Schema.Boolean,
  description: Schema.optionalKey(Schema.String),
  helpText: Schema.optionalKey(Schema.String),
  group: Schema.optionalKey(Schema.String),
  min: Schema.optionalKey(Schema.String),
  max: Schema.optionalKey(Schema.String),
});
export type DateTimeField = Schema.Schema.Type<typeof DateTimeFieldSchema>;

export const SelectFieldSchema = Schema.TaggedStruct("SelectField", {
  label: Schema.String,
  required: Schema.Boolean,
  description: Schema.optionalKey(Schema.String),
  placeholder: Schema.optionalKey(Schema.String),
  helpText: Schema.optionalKey(Schema.String),
  group: Schema.optionalKey(Schema.String),
  options: Schema.Array(Schema.String),
});
export type SelectField = Schema.Schema.Type<typeof SelectFieldSchema>;

export const MultiSelectFieldSchema = Schema.TaggedStruct("MultiSelectField", {
  label: Schema.String,
  required: Schema.Boolean,
  description: Schema.optionalKey(Schema.String),
  placeholder: Schema.optionalKey(Schema.String),
  helpText: Schema.optionalKey(Schema.String),
  group: Schema.optionalKey(Schema.String),
  options: Schema.Array(Schema.String),
  minItems: Schema.optionalKey(Schema.Finite),
  maxItems: Schema.optionalKey(Schema.Finite),
});
export type MultiSelectField = Schema.Schema.Type<typeof MultiSelectFieldSchema>;

export const ImageFieldSchema = Schema.TaggedStruct("ImageField", {
  label: Schema.String,
  required: Schema.Boolean,
  description: Schema.optionalKey(Schema.String),
  helpText: Schema.optionalKey(Schema.String),
  group: Schema.optionalKey(Schema.String),
  accept: Schema.optionalKey(Schema.Array(Schema.String)),
  maxSize: Schema.optionalKey(Schema.Finite),
});
export type ImageField = Schema.Schema.Type<typeof ImageFieldSchema>;

export const AudioFieldSchema = Schema.TaggedStruct("AudioField", {
  label: Schema.String,
  required: Schema.Boolean,
  description: Schema.optionalKey(Schema.String),
  helpText: Schema.optionalKey(Schema.String),
  group: Schema.optionalKey(Schema.String),
  accept: Schema.optionalKey(Schema.Array(Schema.String)),
  maxSize: Schema.optionalKey(Schema.Finite),
});
export type AudioField = Schema.Schema.Type<typeof AudioFieldSchema>;

export const VideoFieldSchema = Schema.TaggedStruct("VideoField", {
  label: Schema.String,
  required: Schema.Boolean,
  description: Schema.optionalKey(Schema.String),
  helpText: Schema.optionalKey(Schema.String),
  group: Schema.optionalKey(Schema.String),
  accept: Schema.optionalKey(Schema.Array(Schema.String)),
  maxSize: Schema.optionalKey(Schema.Finite),
});
export type VideoField = Schema.Schema.Type<typeof VideoFieldSchema>;

export const FileFieldSchema = Schema.TaggedStruct("FileField", {
  label: Schema.String,
  required: Schema.Boolean,
  description: Schema.optionalKey(Schema.String),
  helpText: Schema.optionalKey(Schema.String),
  group: Schema.optionalKey(Schema.String),
  accept: Schema.optionalKey(Schema.Array(Schema.String)),
  maxSize: Schema.optionalKey(Schema.Finite),
});
export type FileField = Schema.Schema.Type<typeof FileFieldSchema>;

export const ReferenceFieldSchema = Schema.TaggedStruct("ReferenceField", {
  label: Schema.String,
  required: Schema.Boolean,
  description: Schema.optionalKey(Schema.String),
  helpText: Schema.optionalKey(Schema.String),
  group: Schema.optionalKey(Schema.String),
  collection: Schema.String,
  multiple: Schema.optionalKey(Schema.Boolean),
});
export type ReferenceField = Schema.Schema.Type<typeof ReferenceFieldSchema>;

export const JsonFieldSchema = Schema.TaggedStruct("JsonField", {
  label: Schema.String,
  required: Schema.Boolean,
  description: Schema.optionalKey(Schema.String),
  placeholder: Schema.optionalKey(Schema.String),
  helpText: Schema.optionalKey(Schema.String),
  group: Schema.optionalKey(Schema.String),
  rows: Schema.optionalKey(Schema.Finite),
});
export type JsonField = Schema.Schema.Type<typeof JsonFieldSchema>;

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
export type SlugField = Schema.Schema.Type<typeof SlugFieldSchema>;

export const UrlFieldSchema = Schema.TaggedStruct("UrlField", {
  label: Schema.String,
  required: Schema.Boolean,
  description: Schema.optionalKey(Schema.String),
  placeholder: Schema.optionalKey(Schema.String),
  helpText: Schema.optionalKey(Schema.String),
  group: Schema.optionalKey(Schema.String),
});
export type UrlField = Schema.Schema.Type<typeof UrlFieldSchema>;

// ─── Recursive types (declared before schema to allow forward reference) ────

export interface RepeaterField {
  readonly _tag: "RepeaterField";
  readonly label: string;
  readonly required: boolean;
  readonly description?: string;
  readonly helpText?: string;
  readonly group?: string;
  readonly fields: readonly CollectionFieldEntry[];
  readonly minItems?: number;
  readonly maxItems?: number;
}

export interface CollectionFieldEntry {
  readonly name: string;
  readonly field: CollectionField;
}

export type CollectionField =
  | TextField
  | LongTextField
  | RichTextField
  | NumberField
  | IntegerField
  | BooleanField
  | DateTimeField
  | SelectField
  | MultiSelectField
  | ImageField
  | AudioField
  | VideoField
  | FileField
  | ReferenceField
  | JsonField
  | SlugField
  | UrlField
  | RepeaterField;

// ─── Recursive schemas ────────────────────────────────────────────────────────

export const CollectionFieldEntrySchema: Schema.Codec<CollectionFieldEntry> =
  Schema.Struct({
    name: Schema.String,
    field: Schema.suspend(
      (): Schema.Codec<CollectionField> => CollectionFieldSchema,
    ),
  });

export const RepeaterFieldSchema: Schema.Codec<RepeaterField> =
  Schema.TaggedStruct("RepeaterField", {
    label: Schema.String,
    required: Schema.Boolean,
    description: Schema.optionalKey(Schema.String),
    helpText: Schema.optionalKey(Schema.String),
    group: Schema.optionalKey(Schema.String),
    fields: Schema.Array(CollectionFieldEntrySchema),
    minItems: Schema.optionalKey(Schema.Finite),
    maxItems: Schema.optionalKey(Schema.Finite),
  });

export const CollectionFieldSchema: Schema.Codec<CollectionField> =
  Schema.Union([
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
