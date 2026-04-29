import type { DatabaseDriver } from "../contracts/driver.js";

export function defineDatabaseDriver(
  driver: DatabaseDriver,
): Readonly<DatabaseDriver> {
  if (!driver || typeof driver !== "object") {
    throw new TypeError("A database driver definition object is required.");
  }

  if (!driver.name || typeof driver.name !== "string") {
    throw new TypeError("A database driver must include a string name.");
  }

  if (!driver.capabilities?.documents) {
    throw new TypeError(
      "A database driver must support the document capability.",
    );
  }

  if (!driver.capabilities?.events) {
    throw new TypeError("A database driver must support the event capability.");
  }

  if (!driver.events || typeof driver.events.append !== "function") {
    throw new TypeError(
      "A database driver must include an event append implementation.",
    );
  }

  if (
    !driver.projections ||
    typeof driver.projections.findDocumentById !== "function"
  ) {
    throw new TypeError(
      "A database driver must include projection read implementations.",
    );
  }

  if (
    driver.schemas &&
    (typeof driver.schemas.list !== "function" ||
      typeof driver.schemas.save !== "function" ||
      typeof driver.schemas.activate !== "function")
  ) {
    throw new TypeError(
      "A database driver schema store must include list, save, and activate implementations.",
    );
  }

  return Object.freeze({ ...driver });
}
