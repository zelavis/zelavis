import test from "node:test";
import assert from "node:assert/strict";
import { validTenantId, tenantKind } from "../app/tenant-ids.ts";
test("a Tenant ID is one safe segment and never the reserved zv namespace", () => {
  for (const ok of ["acme", "Acme-2", "a", "customer_42", "org.team", "9lives"]) assert.equal(validTenantId(ok), true, ok);
  for (const bad of ["", " acme", "a b", "a/b", "-lead", "_lead", ".lead", "zv", "zv.global", "ZV.topology", "service:thing", "a:b", "é", "x".repeat(129)]) assert.equal(validTenantId(bad), false, JSON.stringify(bad));
});
test("Tenants are told apart by who they belong to", () => {
  assert.equal(tenantKind("zelavis-app"), "App");
  assert.equal(tenantKind("service:zelavis-auth-settings"), "Plugin");
  assert.equal(tenantKind("acme"), "Tenant");
});
