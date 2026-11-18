import type { DatabaseRuntimeApi } from "../db/index.js";

export function isDatabaseRuntimeApi(value: unknown): value is DatabaseRuntimeApi {
  return Boolean(
    value &&
      typeof value === "object" &&
      "forTenant" in value &&
      "topology" in value,
  );
}
