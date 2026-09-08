/**
 * Collection naming rules.
 *
 * One definition, used by both the document API and the branded schema types,
 * so a name that a collection can be created under is exactly a name the
 * schema layer will accept.
 */
export const COLLECTION_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Reserved for Zelavis internals; `zv.` namespaces the store's own records. */
export const RESERVED_COLLECTION_PREFIX = "zv";

export const isReservedCollectionName = (name: string): boolean =>
  name.startsWith(`${RESERVED_COLLECTION_PREFIX}_`) ||
  name.startsWith(`${RESERVED_COLLECTION_PREFIX}.`);

export const isValidCollectionName = (name: string): boolean =>
  COLLECTION_NAME_PATTERN.test(name) && !isReservedCollectionName(name);
