import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zelavis, createMemorySystemStore } from "../dist/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";

const PLATFORM_OWNER_CONTEXT = {
  user: { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] },
};

test("service page assets are served directly from package directory on disk", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "zelavis-disk-assets-"));
  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const dashboardDir = join(tempDir, "dashboard");
  const assetsDir = join(tempDir, "assets");
  mkdirSync(dashboardDir, { recursive: true });
  mkdirSync(assetsDir, { recursive: true });

  writeFileSync(
    join(dashboardDir, "index.html"),
    "<!doctype html><html><body><h1>Disk Page</h1></body></html>",
    "utf-8",
  );
  writeFileSync(
    join(dashboardDir, "styles.css"),
    "body { background: #fafafa; }",
    "utf-8",
  );
  writeFileSync(
    join(dashboardDir, "app.js"),
    "console.log('loaded from disk');",
    "utf-8",
  );
  writeFileSync(
    join(dashboardDir, "data.json"),
    JSON.stringify({ message: "hello" }),
    "utf-8",
  );
  writeFileSync(
    join(assetsDir, "icon.svg"),
    "<svg viewBox='0 0 10 10'></svg>",
    "utf-8",
  );
  writeFileSync(
    join(tempDir, "root-page.html"),
    "<!doctype html><html><body>Root Page</body></html>",
    "utf-8",
  );

  const service = {
    name: "@example/disk-plugin",
    kind: "plugin",
    packageDir: tempDir,
    menu: {
      title: "Disk Plugin",
      path: "/disk-plugin",
      page: {
        id: "main",
        title: "Main",
        bundle: "dashboard",
        file: "index.html",
      },
    },
  };

  const runtime = await zelavis({
    systemStore: createMemorySystemStore(),
    resolvePrincipal: () => PLATFORM_OWNER_CONTEXT.user,
    serviceRegistry: {
      catalog: [
        {
          service,
          status: "installed",
        },
      ],
    },
  });

  // 1. Serves HTML with correct headers
  const htmlRes = await runtime.fetch(
    new Request(
      "http://localhost/zelavis/api/v1/runtime/service-page-assets/%40example%2Fdisk-plugin/dashboard/index.html",
    ),
    PLATFORM_OWNER_CONTEXT,
  );
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(htmlRes.headers.get("cache-control"), "no-cache");
  assert.match(await htmlRes.text(), /<h1>Disk Page<\/h1>/);

  // 2. Serves CSS
  const cssRes = await runtime.fetch(
    new Request(
      "http://localhost/zelavis/api/v1/runtime/service-page-assets/%40example%2Fdisk-plugin/dashboard/styles.css",
    ),
    PLATFORM_OWNER_CONTEXT,
  );
  assert.equal(cssRes.status, 200);
  assert.match(cssRes.headers.get("content-type") ?? "", /text\/css/);
  assert.match(await cssRes.text(), /background: #fafafa;/);

  // 3. Serves JS
  const jsRes = await runtime.fetch(
    new Request(
      "http://localhost/zelavis/api/v1/runtime/service-page-assets/%40example%2Fdisk-plugin/dashboard/app.js",
    ),
    PLATFORM_OWNER_CONTEXT,
  );
  assert.equal(jsRes.status, 200);
  assert.match(jsRes.headers.get("content-type") ?? "", /javascript/);
  assert.match(await jsRes.text(), /loaded from disk/);

  // 4. Serves JSON
  const jsonRes = await runtime.fetch(
    new Request(
      "http://localhost/zelavis/api/v1/runtime/service-page-assets/%40example%2Fdisk-plugin/dashboard/data.json",
    ),
    PLATFORM_OWNER_CONTEXT,
  );
  assert.equal(jsonRes.status, 200);
  assert.match(jsonRes.headers.get("content-type") ?? "", /application\/json/);
  const data = await jsonRes.json();
  assert.deepEqual(data, { message: "hello" });

  // 5. Serves SVG asset from another subfolder
  const svgRes = await runtime.fetch(
    new Request(
      "http://localhost/zelavis/api/v1/runtime/service-page-assets/%40example%2Fdisk-plugin/assets/icon.svg",
    ),
    PLATFORM_OWNER_CONTEXT,
  );
  assert.equal(svgRes.status, 200);
  assert.match(svgRes.headers.get("content-type") ?? "", /image\/svg\+xml/);

  // 6. Candidate fallback: bundle 'dist' requested, but file is located directly in packageDir root
  const rootRes = await runtime.fetch(
    new Request(
      "http://localhost/zelavis/api/v1/runtime/service-page-assets/%40example%2Fdisk-plugin/dist/root-page.html",
    ),
    PLATFORM_OWNER_CONTEXT,
  );
  assert.equal(rootRes.status, 200);
  assert.match(await rootRes.text(), /Root Page/);

  // 7. Missing file returns 404
  const missingRes = await runtime.fetch(
    new Request(
      "http://localhost/zelavis/api/v1/runtime/service-page-assets/%40example%2Fdisk-plugin/dashboard/missing.html",
    ),
    PLATFORM_OWNER_CONTEXT,
  );
  assert.equal(missingRes.status, 404);

  // 8. Path traversal attempt returns 400 validation error
  const traversalRes = await runtime.fetch(
    new Request(
      "http://localhost/zelavis/api/v1/runtime/service-page-assets/%40example%2Fdisk-plugin/dashboard/..%2F..%2Fetc/passwd",
    ),
    PLATFORM_OWNER_CONTEXT,
  );
  assert.equal(traversalRes.status, 400);
});

test("createZelavisClient defaults gracefully and auto-detects sandboxed iframe", async (t) => {
  // Standard non-sandboxed client with no options
  const defaultClient = createZelavisClient();
  assert.equal(defaultClient.baseUrl.origin, "http://localhost");
  assert.equal(defaultClient.rootPath, "/zelavis");

  // Mock a sandboxed service page environment
  const originalWindow = globalThis.window;
  t.after(() => {
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  });

  const parentMessages = [];
  const mockParent = {
    postMessage(data, targetOrigin) {
      parentMessages.push({ data, targetOrigin });
    },
  };

  const listeners = [];
  globalThis.window = {
    origin: "null",
    parent: mockParent,
    addEventListener(type, listener) {
      listeners.push({ type, listener });
    },
    removeEventListener(type, listener) {
      const idx = listeners.findIndex((l) => l.listener === listener);
      if (idx >= 0) listeners.splice(idx, 1);
    },
  };

  // createZelavisClient in sandboxed iframe requires no options
  const sandboxedClient = createZelavisClient();
  assert.ok(sandboxedClient);

  // Trigger a request through the sandboxed client
  const pendingPromise = sandboxedClient.request("/orders");
  await new Promise((resolve) => setImmediate(resolve));

  // Verify broker message sent to window.parent
  assert.equal(parentMessages.length, 1);
  const sent = parentMessages[0].data;
  assert.equal(sent.zelavis, "service-page-request");
  assert.equal(sent.path, "/orders");
  assert.equal(sent.method, "GET");

  // Simulate dashboard broker responding
  const messageHandler = listeners.find((l) => l.type === "message")?.listener;
  assert.ok(messageHandler);
  messageHandler({
    source: mockParent,
    data: {
      zelavis: "service-page-response",
      id: sent.id,
      status: 200,
      ok: true,
      body: { orders: [{ id: "ord_1" }] },
    },
  });

  const response = await pendingPromise;
  assert.equal(response.status, 200);
  assert.equal(response.ok, true);
  const resBody = await response.json();
  assert.deepEqual(resBody, { orders: [{ id: "ord_1" }] });
});
