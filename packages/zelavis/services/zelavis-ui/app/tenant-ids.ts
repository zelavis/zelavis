/** A Tenant ID the database takes as one segment: no spaces or slashes, and not the `zv.` namespace it reserves. */
export function validTenantId(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) && !/^zv[._-]/i.test(value);
}

/** Who a Tenant belongs to: the App's own, a plugin's (`service:<name>`), or one the App made. */
export function tenantKind(tenantId: string) {
  return tenantId === "zelavis-app" ? "App" : tenantId.startsWith("service:") ? "Plugin" : "Tenant";
}
