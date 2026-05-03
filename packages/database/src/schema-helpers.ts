import type {
  DatabaseFileSchemaDefinition,
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

export function audioFileSchema(
  options: Omit<CreateDatabaseFileSchemaOptions, "mimeTypes"> & {
    mimeTypes?: readonly string[];
  } = {},
): DatabaseFileSchemaDefinition {
  return fileSchema({
    mimeTypes: options.mimeTypes ?? [
      "audio/mpeg",
      "audio/wav",
      "audio/ogg",
      "audio/webm",
    ],
    maxSize: options.maxSize,
  });
}

export function videoFileSchema(
  options: Omit<CreateDatabaseFileSchemaOptions, "mimeTypes"> & {
    mimeTypes?: readonly string[];
  } = {},
): DatabaseFileSchemaDefinition {
  return fileSchema({
    mimeTypes: options.mimeTypes ?? [
      "video/mp4",
      "video/webm",
      "video/ogg",
      "video/quicktime",
    ],
    maxSize: options.maxSize,
  });
}

export function documentFileSchema(
  options: Omit<CreateDatabaseFileSchemaOptions, "mimeTypes"> & {
    mimeTypes?: readonly string[];
  } = {},
): DatabaseFileSchemaDefinition {
  return fileSchema({
    mimeTypes: options.mimeTypes ?? [
      "application/pdf",
      "text/plain",
      "application/json",
      "application/zip",
    ],
    maxSize: options.maxSize,
  });
}
