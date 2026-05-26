import { expect, test } from "vitest";

import {
  createStarterContentEntry,
  createStarterContentTypeSchema,
} from "./content-schema";

test("starter content type schema requires title and slug", () => {
  expect(createStarterContentTypeSchema()).toMatchObject({
    type: "object",
    additionalProperties: false,
    required: ["title", "slug"],
  });
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
