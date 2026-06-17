import { expect, test } from "vitest";

import {
  contentBuilderInputToEntry,
  contentFieldEntryToBuilderInput,
  createPreviewFieldValue,
  createStarterContentEntry,
  createStarterContentTypeFields,
  inferFieldKindFromEntry,
  initializeFieldDraftValue,
  isMultiSelectSchemaField,
  isReferenceSchemaField,
  normalizeSchemaFieldValue,
  parseCollectionFieldEntriesJson,
  validateCollectionFieldName,
  getContentSchemaFields,
} from "./content-schema";

test("starter content type fields include title and slug", () => {
  const fields = createStarterContentTypeFields();
  expect(fields.some((f) => f.name === "title")).toBe(true);
  expect(fields.some((f) => f.name === "slug")).toBe(true);
  expect(fields.find((f) => f.name === "title")?.field.required).toBe(true);
  expect(fields.find((f) => f.name === "slug")?.field.required).toBe(true);
  expect(fields.find((f) => f.name === "slug")?.field._tag).toBe("SlugField");
  expect(fields.find((f) => f.name === "status")?.field._tag).toBe("SelectField");
});

test("starter content entry matches the starter content type schema shape", () => {
  expect(createStarterContentEntry(123)).toMatchObject({
    title: "Untitled draft",
    slug: "draft-123",
    excerpt: "",
    _content: "",
    status: "draft",
  });
  expect(createStarterContentEntry(123)).not.toHaveProperty("name");
});

test("builder input creates expanded field definitions", () => {
  expect(
    contentBuilderInputToEntry({
      name: "category",
      label: "Category",
      kind: "select",
      required: true,
      options: ["News", "Guide", "News"],
    }),
  ).toMatchObject({
    name: "category",
    field: {
      _tag: "SelectField",
      options: ["News", "Guide"],
      required: true,
    },
  });

  expect(
    contentBuilderInputToEntry({
      name: "author",
      label: "Author",
      kind: "relation",
      relationCollection: "authors",
      relationMultiple: true,
    }),
  ).toMatchObject({
    field: {
      _tag: "ReferenceField",
      collection: "authors",
      multiple: true,
    },
  });

  expect(
    contentBuilderInputToEntry({
      name: "metadata",
      label: "Metadata",
      kind: "json",
      rows: 8,
    }),
  ).toMatchObject({
    field: {
      _tag: "JsonField",
      rows: 8,
    },
  });
});

test("builder input can be restored from an existing field", () => {
  const entry = contentBuilderInputToEntry({
    name: "tags",
    label: "Tags",
    kind: "multi-select",
    options: ["news", "guide"],
    minItems: 1,
    maxItems: 2,
  });

  expect(inferFieldKindFromEntry(entry)).toBe("multi-select");
  expect(contentFieldEntryToBuilderInput(entry)).toMatchObject({
    name: "tags",
    kind: "multi-select",
    options: ["news", "guide"],
    minItems: 1,
    maxItems: 2,
  });
});

test("field name validation rejects invalid identifiers", () => {
  expect(validateCollectionFieldName("authorBio")).toBeUndefined();
  expect(validateCollectionFieldName("9invalid")).toMatch(/letter or underscore/);
  expect(validateCollectionFieldName("")).toMatch(/required/);
});

test("schema json parsing validates field entries", () => {
  expect(() =>
    parseCollectionFieldEntriesJson(
      JSON.stringify([
        { name: "title", field: { _tag: "TextField", label: "Title", required: true } },
      ]),
    ),
  ).not.toThrow();

  expect(() =>
    parseCollectionFieldEntriesJson(JSON.stringify([{ name: "bad name", field: { _tag: "TextField" } }])),
  ).toThrow();
});

test("reference and multi-select draft helpers preserve shapes", () => {
  const referenceDefinition = contentBuilderInputToEntry({
    name: "author",
    label: "Author",
    kind: "relation",
    relationCollection: "authors",
  }).field;
  const referenceField = getContentSchemaFields([
    { name: "author", field: referenceDefinition },
  ])[0]!;

  expect(isReferenceSchemaField(referenceField.definition)).toBe(true);
  expect(
    initializeFieldDraftValue(referenceField.definition, { collection: "authors", id: "a1" }),
  ).toEqual({ collection: "authors", id: "a1" });
  expect(
    normalizeSchemaFieldValue(referenceField.definition, { collection: "authors", id: "a1" }),
  ).toEqual({ collection: "authors", id: "a1" });

  const tagsDefinition = contentBuilderInputToEntry({
    name: "tags",
    label: "Tags",
    kind: "multi-select",
    options: ["news", "guide"],
  }).field;
  const tagsField = getContentSchemaFields([{ name: "tags", field: tagsDefinition }])[0]!;

  expect(isMultiSelectSchemaField(tagsField.definition)).toBe(true);
  expect(createPreviewFieldValue(tagsField.definition)).toEqual([]);
});
