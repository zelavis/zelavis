import { Schema } from "effect";
import { isValidCollectionName } from "../naming.js";

export const CollectionName = Schema.String.check(
  Schema.makeFilter(
    (n) => (isValidCollectionName(n) ? undefined : "Collection name is invalid or reserved"),
    { title: "CollectionName" },
  ),
).pipe(Schema.brand("CollectionName"));
export type CollectionName = Schema.Schema.Type<typeof CollectionName>;

export const TenantId = Schema.String.check(
  Schema.makeFilter(
    (s) => (s.length > 0 ? undefined : "TenantId must be non-empty"),
    { title: "TenantId" },
  ),
).pipe(Schema.brand("TenantId"));
export type TenantId = Schema.Schema.Type<typeof TenantId>;

export const DocumentId = Schema.String.check(
  Schema.makeFilter(
    (s) => (s.length > 0 ? undefined : "DocumentId must be non-empty"),
    { title: "DocumentId" },
  ),
).pipe(Schema.brand("DocumentId"));
export type DocumentId = Schema.Schema.Type<typeof DocumentId>;

export const FieldName = Schema.String.check(
  Schema.makeFilter(
    (s) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)
        ? undefined
        : "Field names must start with a letter or underscore and contain only letters, numbers, or underscores",
    { title: "FieldName" },
  ),
).pipe(Schema.brand("FieldName"));
export type FieldName = Schema.Schema.Type<typeof FieldName>;
