import { Schema } from "effect";

// ─── Leaf field definitions ─────────────────────────────────────────────────

export const TextFieldSchema = Schema.TaggedStruct("TextField", {
  label: Schema.String,
  required: Schema.Boolean,
});
export type TextField = Schema.Schema.Type<typeof TextFieldSchema>;

export const RichTextFieldSchema = Schema.TaggedStruct("RichTextField", {
  label: Schema.String,
  required: Schema.Boolean,
});
export type RichTextField = Schema.Schema.Type<typeof RichTextFieldSchema>;

export const NumberFieldSchema = Schema.TaggedStruct("NumberField", {
  label: Schema.String,
  required: Schema.Boolean,
  min: Schema.optionalKey(Schema.Number),
  max: Schema.optionalKey(Schema.Number),
  integer: Schema.optionalKey(Schema.Boolean),
});
export type NumberField = Schema.Schema.Type<typeof NumberFieldSchema>;

export const BooleanFieldSchema = Schema.TaggedStruct("BooleanField", {
  label: Schema.String,
  required: Schema.Boolean,
});
export type BooleanField = Schema.Schema.Type<typeof BooleanFieldSchema>;

export const ImageFieldSchema = Schema.TaggedStruct("ImageField", {
  label: Schema.String,
  required: Schema.Boolean,
  accept: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type ImageField = Schema.Schema.Type<typeof ImageFieldSchema>;

export const AudioFieldSchema = Schema.TaggedStruct("AudioField", {
  label: Schema.String,
  required: Schema.Boolean,
  accept: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type AudioField = Schema.Schema.Type<typeof AudioFieldSchema>;

export const VideoFieldSchema = Schema.TaggedStruct("VideoField", {
  label: Schema.String,
  required: Schema.Boolean,
  accept: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type VideoField = Schema.Schema.Type<typeof VideoFieldSchema>;

export const FileFieldSchema = Schema.TaggedStruct("FileField", {
  label: Schema.String,
  required: Schema.Boolean,
  accept: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type FileField = Schema.Schema.Type<typeof FileFieldSchema>;

// ─── Recursive types (declared before schema to allow forward reference) ────

export interface RepeaterField {
  readonly _tag: "RepeaterField";
  readonly label: string;
  readonly required: boolean;
  readonly fields: readonly CollectionFieldEntry[];
}

export interface CollectionFieldEntry {
  readonly name: string;
  readonly field: CollectionField;
}

export type CollectionField =
  | TextField
  | RichTextField
  | NumberField
  | BooleanField
  | ImageField
  | AudioField
  | VideoField
  | FileField
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
    fields: Schema.Array(CollectionFieldEntrySchema),
  });

export const CollectionFieldSchema: Schema.Codec<CollectionField> =
  Schema.Union([
    TextFieldSchema,
    RichTextFieldSchema,
    NumberFieldSchema,
    BooleanFieldSchema,
    ImageFieldSchema,
    AudioFieldSchema,
    VideoFieldSchema,
    FileFieldSchema,
    RepeaterFieldSchema,
  ]);
