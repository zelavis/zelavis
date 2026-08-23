import { Schema } from "effect";
export declare const TextFieldSchema: Schema.TaggedStruct<"TextField", {
    readonly label: Schema.String;
    readonly required: Schema.Boolean;
    readonly description: Schema.optionalKey<Schema.String>;
    readonly placeholder: Schema.optionalKey<Schema.String>;
    readonly helpText: Schema.optionalKey<Schema.String>;
    readonly group: Schema.optionalKey<Schema.String>;
    readonly minLength: Schema.optionalKey<Schema.Number>;
    readonly maxLength: Schema.optionalKey<Schema.Number>;
    readonly pattern: Schema.optionalKey<Schema.String>;
}>;
export type TextField = Schema.Schema.Type<typeof TextFieldSchema>;
export declare const LongTextFieldSchema: Schema.TaggedStruct<"LongTextField", {
    readonly label: Schema.String;
    readonly required: Schema.Boolean;
    readonly description: Schema.optionalKey<Schema.String>;
    readonly placeholder: Schema.optionalKey<Schema.String>;
    readonly helpText: Schema.optionalKey<Schema.String>;
    readonly group: Schema.optionalKey<Schema.String>;
    readonly rows: Schema.optionalKey<Schema.Number>;
    readonly minLength: Schema.optionalKey<Schema.Number>;
    readonly maxLength: Schema.optionalKey<Schema.Number>;
}>;
export type LongTextField = Schema.Schema.Type<typeof LongTextFieldSchema>;
export declare const RichTextFieldSchema: Schema.TaggedStruct<"RichTextField", {
    readonly label: Schema.String;
    readonly required: Schema.Boolean;
    readonly description: Schema.optionalKey<Schema.String>;
    readonly placeholder: Schema.optionalKey<Schema.String>;
    readonly helpText: Schema.optionalKey<Schema.String>;
    readonly group: Schema.optionalKey<Schema.String>;
}>;
export type RichTextField = Schema.Schema.Type<typeof RichTextFieldSchema>;
export declare const NumberFieldSchema: Schema.TaggedStruct<"NumberField", {
    readonly label: Schema.String;
    readonly required: Schema.Boolean;
    readonly description: Schema.optionalKey<Schema.String>;
    readonly placeholder: Schema.optionalKey<Schema.String>;
    readonly helpText: Schema.optionalKey<Schema.String>;
    readonly group: Schema.optionalKey<Schema.String>;
    readonly min: Schema.optionalKey<Schema.Number>;
    readonly max: Schema.optionalKey<Schema.Number>;
    readonly integer: Schema.optionalKey<Schema.Boolean>;
}>;
export type NumberField = Schema.Schema.Type<typeof NumberFieldSchema>;
export declare const IntegerFieldSchema: Schema.TaggedStruct<"IntegerField", {
    readonly label: Schema.String;
    readonly required: Schema.Boolean;
    readonly description: Schema.optionalKey<Schema.String>;
    readonly placeholder: Schema.optionalKey<Schema.String>;
    readonly helpText: Schema.optionalKey<Schema.String>;
    readonly group: Schema.optionalKey<Schema.String>;
    readonly min: Schema.optionalKey<Schema.Number>;
    readonly max: Schema.optionalKey<Schema.Number>;
}>;
export type IntegerField = Schema.Schema.Type<typeof IntegerFieldSchema>;
export declare const BooleanFieldSchema: Schema.TaggedStruct<"BooleanField", {
    readonly label: Schema.String;
    readonly required: Schema.Boolean;
    readonly description: Schema.optionalKey<Schema.String>;
    readonly helpText: Schema.optionalKey<Schema.String>;
    readonly group: Schema.optionalKey<Schema.String>;
}>;
export type BooleanField = Schema.Schema.Type<typeof BooleanFieldSchema>;
export declare const DateTimeFieldSchema: Schema.TaggedStruct<"DateTimeField", {
    readonly label: Schema.String;
    readonly required: Schema.Boolean;
    readonly description: Schema.optionalKey<Schema.String>;
    readonly helpText: Schema.optionalKey<Schema.String>;
    readonly group: Schema.optionalKey<Schema.String>;
    readonly min: Schema.optionalKey<Schema.String>;
    readonly max: Schema.optionalKey<Schema.String>;
}>;
export type DateTimeField = Schema.Schema.Type<typeof DateTimeFieldSchema>;
export declare const SelectFieldSchema: Schema.TaggedStruct<"SelectField", {
    readonly label: Schema.String;
    readonly required: Schema.Boolean;
    readonly description: Schema.optionalKey<Schema.String>;
    readonly placeholder: Schema.optionalKey<Schema.String>;
    readonly helpText: Schema.optionalKey<Schema.String>;
    readonly group: Schema.optionalKey<Schema.String>;
    readonly options: Schema.$Array<Schema.String>;
}>;
export type SelectField = Schema.Schema.Type<typeof SelectFieldSchema>;
export declare const MultiSelectFieldSchema: Schema.TaggedStruct<"MultiSelectField", {
    readonly label: Schema.String;
    readonly required: Schema.Boolean;
    readonly description: Schema.optionalKey<Schema.String>;
    readonly placeholder: Schema.optionalKey<Schema.String>;
    readonly helpText: Schema.optionalKey<Schema.String>;
    readonly group: Schema.optionalKey<Schema.String>;
    readonly options: Schema.$Array<Schema.String>;
    readonly minItems: Schema.optionalKey<Schema.Number>;
    readonly maxItems: Schema.optionalKey<Schema.Number>;
}>;
export type MultiSelectField = Schema.Schema.Type<typeof MultiSelectFieldSchema>;
export declare const ImageFieldSchema: Schema.TaggedStruct<"ImageField", {
    readonly label: Schema.String;
    readonly required: Schema.Boolean;
    readonly description: Schema.optionalKey<Schema.String>;
    readonly helpText: Schema.optionalKey<Schema.String>;
    readonly group: Schema.optionalKey<Schema.String>;
    readonly accept: Schema.optionalKey<Schema.$Array<Schema.String>>;
    readonly maxSize: Schema.optionalKey<Schema.Number>;
}>;
export type ImageField = Schema.Schema.Type<typeof ImageFieldSchema>;
export declare const AudioFieldSchema: Schema.TaggedStruct<"AudioField", {
    readonly label: Schema.String;
    readonly required: Schema.Boolean;
    readonly description: Schema.optionalKey<Schema.String>;
    readonly helpText: Schema.optionalKey<Schema.String>;
    readonly group: Schema.optionalKey<Schema.String>;
    readonly accept: Schema.optionalKey<Schema.$Array<Schema.String>>;
    readonly maxSize: Schema.optionalKey<Schema.Number>;
}>;
export type AudioField = Schema.Schema.Type<typeof AudioFieldSchema>;
export declare const VideoFieldSchema: Schema.TaggedStruct<"VideoField", {
    readonly label: Schema.String;
    readonly required: Schema.Boolean;
    readonly description: Schema.optionalKey<Schema.String>;
    readonly helpText: Schema.optionalKey<Schema.String>;
    readonly group: Schema.optionalKey<Schema.String>;
    readonly accept: Schema.optionalKey<Schema.$Array<Schema.String>>;
    readonly maxSize: Schema.optionalKey<Schema.Number>;
}>;
export type VideoField = Schema.Schema.Type<typeof VideoFieldSchema>;
export declare const FileFieldSchema: Schema.TaggedStruct<"FileField", {
    readonly label: Schema.String;
    readonly required: Schema.Boolean;
    readonly description: Schema.optionalKey<Schema.String>;
    readonly helpText: Schema.optionalKey<Schema.String>;
    readonly group: Schema.optionalKey<Schema.String>;
    readonly accept: Schema.optionalKey<Schema.$Array<Schema.String>>;
    readonly maxSize: Schema.optionalKey<Schema.Number>;
}>;
export type FileField = Schema.Schema.Type<typeof FileFieldSchema>;
export declare const ReferenceFieldSchema: Schema.TaggedStruct<"ReferenceField", {
    readonly label: Schema.String;
    readonly required: Schema.Boolean;
    readonly description: Schema.optionalKey<Schema.String>;
    readonly helpText: Schema.optionalKey<Schema.String>;
    readonly group: Schema.optionalKey<Schema.String>;
    readonly collection: Schema.String;
    readonly multiple: Schema.optionalKey<Schema.Boolean>;
}>;
export type ReferenceField = Schema.Schema.Type<typeof ReferenceFieldSchema>;
export declare const JsonFieldSchema: Schema.TaggedStruct<"JsonField", {
    readonly label: Schema.String;
    readonly required: Schema.Boolean;
    readonly description: Schema.optionalKey<Schema.String>;
    readonly placeholder: Schema.optionalKey<Schema.String>;
    readonly helpText: Schema.optionalKey<Schema.String>;
    readonly group: Schema.optionalKey<Schema.String>;
    readonly rows: Schema.optionalKey<Schema.Number>;
}>;
export type JsonField = Schema.Schema.Type<typeof JsonFieldSchema>;
export declare const SlugFieldSchema: Schema.TaggedStruct<"SlugField", {
    readonly label: Schema.String;
    readonly required: Schema.Boolean;
    readonly description: Schema.optionalKey<Schema.String>;
    readonly placeholder: Schema.optionalKey<Schema.String>;
    readonly helpText: Schema.optionalKey<Schema.String>;
    readonly group: Schema.optionalKey<Schema.String>;
    readonly from: Schema.optionalKey<Schema.String>;
    readonly pattern: Schema.optionalKey<Schema.String>;
}>;
export type SlugField = Schema.Schema.Type<typeof SlugFieldSchema>;
export declare const UrlFieldSchema: Schema.TaggedStruct<"UrlField", {
    readonly label: Schema.String;
    readonly required: Schema.Boolean;
    readonly description: Schema.optionalKey<Schema.String>;
    readonly placeholder: Schema.optionalKey<Schema.String>;
    readonly helpText: Schema.optionalKey<Schema.String>;
    readonly group: Schema.optionalKey<Schema.String>;
}>;
export type UrlField = Schema.Schema.Type<typeof UrlFieldSchema>;
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
export type CollectionField = TextField | LongTextField | RichTextField | NumberField | IntegerField | BooleanField | DateTimeField | SelectField | MultiSelectField | ImageField | AudioField | VideoField | FileField | ReferenceField | JsonField | SlugField | UrlField | RepeaterField;
export declare const CollectionFieldEntrySchema: Schema.Codec<CollectionFieldEntry>;
export declare const RepeaterFieldSchema: Schema.Codec<RepeaterField>;
export declare const CollectionFieldSchema: Schema.Codec<CollectionField>;
