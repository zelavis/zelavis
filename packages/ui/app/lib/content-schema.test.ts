import { expect, test } from "vitest";

import {
  createStarterContentEntry,
  createStarterContentTypeFields,
} from "./content-schema";

test("starter content type fields include title and slug", () => {
  const fields = createStarterContentTypeFields();
  expect(fields.some((f) => f.name === "title")).toBe(true);
  expect(fields.some((f) => f.name === "slug")).toBe(true);
  expect(fields.find((f) => f.name === "title")?.field.required).toBe(true);
  expect(fields.find((f) => f.name === "slug")?.field.required).toBe(true);
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
