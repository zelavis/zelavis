import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Zelavis } from "../../../packages/zelavis/dist/index.js";
import { nodeAdapter } from "../../../packages/zelavis/dist/adapters/node.js";

const owner = { principal: { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] } };

test("Ecommerce on the Node Platform retains a product across a Platform restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "zv-platform-ecommerce-"));
  const platforms = [];
  const start = () => {
    const zv = new Zelavis({ adapter: nodeAdapter({
      dataDirectory: directory, projects: false, terminal: false,
      services: { marketplace: { sources: [], officialServicesDirectory: new URL("../..", import.meta.url).pathname } },
    }) });
    platforms.push(zv);
    return zv;
  };
  try {
    const first = start();
    const installed = await first.fetch(new Request("http://localhost/zelavis/api/v1/runtime/services/%40zelavis%2Fecommerce", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "installed" }),
    }), owner);
    assert.equal(installed.status, 200, await installed.text());
    const response = await first.fetch(new Request("http://localhost/zelavis/api/v1/plugins/ecommerce/products", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Durable hosting plan", price: { amount: 1900, currency: "EUR" } }),
    }), owner);
    const created = await response.json();
    assert.equal(response.status, 201, JSON.stringify(created));
    assert.equal(typeof created.id, "string");
    await first.close();

    const second = start();
    const product = await second.fetch(new Request(`http://localhost/zelavis/api/v1/plugins/ecommerce/products/${encodeURIComponent(created.id)}`), owner);
    assert.equal(product.status, 200);
    const persisted = await product.json();
    assert.equal(persisted.id, created.id);
    assert.equal(persisted.title, "Durable hosting plan");
    assert.deepEqual(persisted.price, { amount: 1900, currency: "EUR" });
    const config = await (await second.fetch(new Request("http://localhost/zelavis/api/v1/runtime/config"), owner)).json();
    assert.equal(config.capabilities.database.available, false);
  } finally {
    for (const zv of platforms.reverse()) await zv.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
