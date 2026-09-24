import assert from "node:assert/strict";
import test from "node:test";

import { isValidTenantId } from "../dist/db/naming.js";

test("a Tenant id may not be mistaken for a different Tenant", () => {
  assert.equal(isValidTenantId("fluxgent"), true);
  assert.equal(isValidTenantId("acme-corp"), true);
  assert.equal(isValidTenantId("tenant.eu-west"), true);
  assert.equal(isValidTenantId("a"), true);

  // `tenantOf` recovers a Tenant by slicing a namespace at the first `/`, so
  // a separator in the id would read back as a different Tenant entirely.
  assert.equal(isValidTenantId("acme/globex"), false);
  assert.equal(isValidTenantId("acme corp"), false);
  assert.equal(isValidTenantId(""), false);
  assert.equal(isValidTenantId("-leading-dash"), false);
  assert.equal(isValidTenantId("x".repeat(129)), false);

  // The store's own prefix, and the reserved global Tenant beneath it.
  assert.equal(isValidTenantId("zv"), false);
  assert.equal(isValidTenantId("zv.global"), false);
  assert.equal(isValidTenantId("zv.anything"), false);
  // Not reserved merely for starting with those letters.
  assert.equal(isValidTenantId("zvelte"), true);
});
