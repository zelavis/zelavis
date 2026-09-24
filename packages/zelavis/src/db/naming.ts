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

/**
 * What a Tenant may be called.
 *
 * A Tenant id is not a label: it is part of the storage namespace, and
 * `tenantOf` recovers it by slicing a namespace at the first `/`. An id
 * carrying a separator would be read back as a different Tenant, so the
 * charset is closed rather than merely discouraged. `zv.` is the store's own
 * prefix and `zv.global` is a real reserved Tenant, so the whole prefix stays
 * out of reach.
 */
export const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const isReservedTenantId = (tenant: string): boolean =>
  tenant === RESERVED_COLLECTION_PREFIX || tenant.startsWith(`${RESERVED_COLLECTION_PREFIX}.`);

export const isValidTenantId = (tenant: string): boolean =>
  TENANT_ID_PATTERN.test(tenant) && !isReservedTenantId(tenant);
