import assert from "node:assert/strict";
import test from "node:test";

import { zelavis as boot } from "../dist/index.js";
import { zelavis, createZelavisClient } from "../dist/sdk/fetch.js";
import { loadPluginPackage } from "../dist/service.js";

const owner = { principal: { id: "owner", type: "user", permissions: ["*"] } };

async function service(namespace, count = 1) {
  return loadPluginPackage({
    manifest: { name: `@discovery/${namespace}`, type: "module", exports: "./index.js", zelavis: { kind: "plugin", namespace } },
    importer: async () => {
      for (let index = 0; index < count; index += 1) {
        zelavis.operations.create({
          id: `items${index}.list`, resource: `items${index}`, action: "list",
          method: "GET", path: `/items${index}`,
          spec: { operationId: `listItems${index}`, summary: "List items" },
          handler: () => ({ status: 200, body: { ok: true } }),
        });
      }
      return {};
    },
  });
}

test("SDK discovery revalidates every call and transfers the catalogue only when it changes", async (t) => {
  const catalog = [{ service: await service("shop"), status: "installed" }];
  const runtime = await boot({ serviceRegistry: { catalog } });
  t.after(() => runtime.close());
  const exchanges = [];
  const fetcher = async (url, init) => {
    const response = await runtime.fetch(new Request(url, init), owner);
    const path = new URL(url).pathname;
    if (path.endsWith("/runtime/plugin-operations")) {
      exchanges.push({ status: response.status, bytes: (await response.clone().arrayBuffer()).byteLength });
    }
    return response;
  };
  const client = createZelavisClient({ baseUrl: "http://localhost", fetch: fetcher });

  for (let call = 0; call < 5; call += 1) {
    assert.deepEqual(await client.plugins.shop.items0.list(), { ok: true });
  }
  assert.deepEqual(exchanges.map((exchange) => exchange.status), [200, 304, 304, 304, 304]);
  assert.ok(exchanges[0].bytes > 0);
  assert.deepEqual(exchanges.slice(1).map((exchange) => exchange.bytes), [0, 0, 0, 0]);

  // A stale ETag from another catalogue is not honoured.
  const stale = await runtime.fetch(new Request("http://localhost/zelavis/api/v1/runtime/plugin-operations", {
    headers: { "if-none-match": "\"0000\"" },
  }), owner);
  assert.equal(stale.status, 200);
  assert.equal(stale.headers.get("cache-control"), "no-cache");
  const body = await stale.json();
  assert.equal(`"${body.revision}"`, stale.headers.get("etag"));
});

test("an uninstalled operation is gone on the next call despite the cached catalogue", async (t) => {
  const installed = await boot({ serviceRegistry: { catalog: [{ service: await service("shop"), status: "installed" }] } });
  const empty = await boot({ serviceRegistry: { catalog: [{ service: await service("shop"), status: "available" }] } });
  t.after(() => Promise.all([installed.close(), empty.close()]));
  // One client whose server changes underneath it, as after an uninstall.
  let current = installed;
  const client = createZelavisClient({
    baseUrl: "http://localhost",
    fetch: (url, init) => current.fetch(new Request(url, init), owner),
  });
  assert.deepEqual(await client.plugins.shop.items0.list(), { ok: true });
  current = empty;
  await assert.rejects(client.plugins.shop.items0.list(), /Unknown plugin operation/);
});

test("catalogue size stays within the per-operation budget", async (t) => {
  const runtime = await boot({ serviceRegistry: { catalog: [{ service: await service("wide", 100), status: "installed" }] } });
  t.after(() => runtime.close());
  const response = await runtime.fetch(new Request("http://localhost/zelavis/api/v1/runtime/plugin-operations"), owner);
  const bytes = (await response.arrayBuffer()).byteLength;
  // Budget: 400 bytes per operation with this minimal spec (measured 165 on 2026-09-17).
  assert.ok(bytes <= 100 * 400, `catalogue is ${bytes} bytes for 100 operations`);
});
