import type {
  DatabaseFileSchemaDefinition,
  DatabaseSchemaDefinition,
} from "./contracts/schemas.js";

export interface CreateDatabaseFileSchemaOptions {
  mimeTypes?: readonly string[];
  maxSize?: number;
}

export function fileSchema(
  options: CreateDatabaseFileSchemaOptions = {},
): DatabaseFileSchemaDefinition {
  return {
    type: "file",
    ...(options.mimeTypes ? { mimeTypes: [...options.mimeTypes] } : {}),
    ...(options.maxSize !== undefined ? { maxSize: options.maxSize } : {}),
  };
}

export function imageFileSchema(
  options: Omit<CreateDatabaseFileSchemaOptions, "mimeTypes"> & {
    mimeTypes?: readonly string[];
  } = {},
): DatabaseFileSchemaDefinition {
  return fileSchema({
    mimeTypes: options.mimeTypes ?? [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
    ],
    maxSize: options.maxSize,
  });
}

export function mergeObjectProperties(
  properties: Record<string, DatabaseSchemaDefinition>,
): Record<string, DatabaseSchemaDefinition> {
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [key, value]),
  );
}
