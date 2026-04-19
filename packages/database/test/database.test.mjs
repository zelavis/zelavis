import assert from "node:assert/strict";
import test from "node:test";
import { createDatabase } from "../dist/index.js";

test("database documents support tenant-aware CRUD operations", async () => {
  const database = await createDatabase();

  await database.documents.createCollection({ name: "products" });
  await database.documents.createCollection({ tenantId: "enterprise", name: "products" });

  const product = await database.documents.insert({
    collection: "products",
    data: {
      name: "T-shirt",
      status: "published",
      price: 25,
    },
  });

  await database.documents.insert({
    tenantId: "enterprise",
    collection: "products",
    data: {
      name: "Private catalog",
      status: "published",
      price: 50,
    },
  });

  const found = await database.documents.findById({
    collection: "products",
    id: product.id,
  });
  assert.equal(found.data.name, "T-shirt");

  const defaultTenantProducts = await database.documents.findMany({
    collection: "products",
    where: [{ path: "status", value: "published" }],
  });
  assert.equal(defaultTenantProducts.length, 1);
  assert.equal(defaultTenantProducts[0].tenantId, "default");

  const updated = await database.documents.update({
    collection: "products",
    id: product.id,
    data: { status: "archived" },
  });
  assert.equal(updated.version, 2);
  assert.equal(updated.data.name, "T-shirt");
  assert.equal(updated.data.status, "archived");

  assert.equal(
    await database.documents.delete({
      collection: "products",
      id: product.id,
    }),
    true,
  );
});

test("database keeps SQL as an optional capability", async () => {
  const database = await createDatabase();

  assert.equal(database.capabilities.documents, true);
  assert.equal(database.capabilities.sql, false);
  assert.equal(database.sql, undefined);
});
