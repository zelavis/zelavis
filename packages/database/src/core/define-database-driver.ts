import type { DatabaseDriver } from "../contracts/driver.js";

export function defineDatabaseDriver(driver: DatabaseDriver): Readonly<DatabaseDriver> {
  if (!driver || typeof driver !== "object") {
    throw new TypeError("A database driver definition object is required.");
  }

  if (!driver.name || typeof driver.name !== "string") {
    throw new TypeError("A database driver must include a string name.");
  }

  if (!driver.capabilities?.documents) {
    throw new TypeError("A database driver must support the document capability.");
  }

  return Object.freeze({ ...driver });
}
