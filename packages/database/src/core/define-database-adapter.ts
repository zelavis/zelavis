import type { DatabaseAdapter } from "../contracts/adapter.js";

export function defineDatabaseAdapter(adapter: DatabaseAdapter): Readonly<DatabaseAdapter> {
  if (!adapter || typeof adapter !== "object") {
    throw new TypeError("A database adapter definition object is required.");
  }

  if (!adapter.name || typeof adapter.name !== "string") {
    throw new TypeError("A database adapter must include a string name.");
  }

  if (!adapter.capabilities?.documents) {
    throw new TypeError("A database adapter must support the document capability.");
  }

  return Object.freeze({ ...adapter });
}
