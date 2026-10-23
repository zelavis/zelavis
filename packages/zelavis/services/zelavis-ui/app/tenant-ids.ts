/** The database's own rule for what an operator may name a Tenant (`TENANT_ID_PATTERN`), and not the `zv.` namespace it reserves. `service:` Tenants are plugins', made by plugins. */
export function validTenantId(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !/^zv(\.|$)/i.test(value);
}

/** Who a Tenant belongs to: the App's own, a plugin's (`service:<name>`), or one the App made. */
export function tenantKind(tenantId: string) {
  return tenantId === "zelavis-app" ? "App" : tenantId.startsWith("service:") ? "Plugin" : "Tenant";
}
