import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { zelavis as boot } from "../dist/index.js";
import { zelavis, createZelavisClient } from "../dist/sdk/fetch.js";
import { loadPluginPackage, createServiceRegistry, validatePluginPackageManifest } from "../dist/service.js";
import { runPluginsCommand } from "../dist/cli/plugins.js";
import { zelavisUiFrontend } from "@zelavis/ui/frontend";

const manifest = (namespace = "seotool", name = "@example/seo") => ({
  name, type: "module", exports: "./index.js", zelavis: { kind: "plugin", namespace },
});
const owner = { principal: { id: "owner", type: "user", permissions: ["*"] } };

test("namespaces are explicit, valid identifiers and cannot shadow JS protocol properties", () => {
  for (const namespace of [undefined, "", "seo-tool", "SEO", "../ui", "a.b", "constructor", "then", "toJSON", "__proto__"]) {
    const input = manifest();
    input.zelavis.namespace = namespace;
    assert.throws(() => validatePluginPackageManifest(input), /namespace/);
  }
  assert.doesNotThrow(() => validatePluginPackageManifest(manifest("seoTool")));
});

test("namespace collisions are rejected within a registry, not across independent registries", async () => {
  const first = await loadPluginPackage({ manifest: manifest(), importer: async () => ({}) });
  const second = await loadPluginPackage({ manifest: manifest("seotool", "@other/seo"), importer: async () => ({}) });
  const entry = (service) => ({ service, status: "installed" });
  assert.throws(() => createServiceRegistry([entry(first), entry(second)]), /already owned/);
  assert.doesNotThrow(() => createServiceRegistry([entry(second)]));
});

test("installed packages cannot take the active frontend's namespace", async () => {
  const service = await loadPluginPackage({ manifest: manifest("ui"), importer: async () => ({}) });
  await assert.rejects(boot({
    frontend: zelavisUiFrontend,
    serviceRegistry: { catalog: [{ service, status: "installed" }] },
  }), /namespace "ui" is already owned/);
});

test("invalid namespaces fail before module evaluation and operation paths cannot escape their owner", async () => {
  let evaluated = false;
  await assert.rejects(loadPluginPackage({
    manifest: manifest("../ui"), importer: async () => { evaluated = true; return {}; },
  }), /namespace/);
  assert.equal(evaluated, false);
  for (const path of ["/../auth", "/%2e%2e/auth", "/audits?other=1", "/audits/*path"]) {
    await assert.rejects(loadPluginPackage({ manifest: manifest(), importer: async () => {
      zelavis.operations.create({ id: "test", resource: "audits", action: "get", method: "GET", path,
        spec: { operationId: "getAudits" }, handler: () => ({ status: 200, body: {} }),
      });
      return {};
    } }), /resource path/);
  }
});

test("the manifest owns the namespace and the old menu SDK alias is gone", async () => {
  const service = await loadPluginPackage({
    manifest: manifest(),
    importer: async () => {
      zelavis.plugins.ui.menus.create({ title: "SEO", path: "/seo" });
      return { name: "@example/seo", basePath: "/ui" };
    },
  });
  assert.equal(service.namespace, "seotool");
  assert.equal(service.basePath, "/plugins/seotool");
  assert.equal(service.menus.length, 1);
  assert.equal("menu" in zelavis, false);
  await assert.rejects(loadPluginPackage({
    manifest: manifest(), importer: async () => ({ name: "@example/seo", namespace: "ui" }),
  }), /cannot override/);
});

test("a third-party operation shares HTTP, SDK and CLI behavior under a custom root", async (t) => {
  const service = await loadPluginPackage({
    manifest: manifest(),
    importer: async () => {
      zelavis.operations.create({
        id: "seo.audits.create", resource: "audits", action: "create",
        method: "POST", path: "/audits",
        access: { permissions: ["seo.audit"], scope: { type: "system" } },
        spec: { operationId: "createAudit", summary: "Create an SEO audit", requestBody: {
          required: true, schema: { type: "object", required: ["url"], properties: { url: { type: "string" } } },
        } },
        handler: ({ body }) => typeof body?.url === "string"
          ? { status: 201, body: { url: body.url, state: "created" } }
          : { status: 400, body: { error: "A URL is required." } },
      });
      return {};
    },
  });
  const runtime = await boot({ rootPath: "/custom", serviceRegistry: { catalog: [{ service, status: "installed" }] } });
  t.after(() => runtime.close());
  const fetcher = (url, init) => runtime.fetch(new Request(url, init), owner);
  const client = createZelavisClient({ baseUrl: "http://localhost", rootPath: "/custom", fetch: fetcher });
  const input = { url: "https://example.com" };
  const response = await fetcher("http://localhost/custom/api/v1/plugins/seotool/audits", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  assert.equal(response.status, 201);
  const expected = await response.json();
  assert.deepEqual(await client.plugins.seotool.audits.create(input), expected);
  assert.equal((await client.pluginOperations())[0].namespace, "seotool");
  await assert.rejects(client.plugins.seotool.audits.create({}), (error) => error.response.status === 400);
  const anonymous = createZelavisClient({ baseUrl: "http://localhost", rootPath: "/custom", fetch: (url, init) => runtime.fetch(new Request(url, init)) });
  await assert.rejects(anonymous.plugins.seotool.audits.create(input), (error) => [401, 403].includes(error.response.status));
  await assert.rejects(client.plugins.unknown.audits.create(input), /Unknown plugin operation/);
  const inactive = await boot({ serviceRegistry: { catalog: [{ service, status: "available" }] } });
  t.after(() => inactive.close());
  const inactiveClient = createZelavisClient({
    baseUrl: "http://localhost", fetch: (url, init) => inactive.fetch(new Request(url, init), owner),
  });
  assert.deepEqual(await inactiveClient.pluginOperations(), []);
  await assert.rejects(inactiveClient.plugins.seotool.audits.create(input), /Unknown plugin operation/);
  assert.equal((await inactive.fetch(new Request("http://localhost/zelavis/api/v1/plugins/seotool/audits", {
    method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" },
  }), owner)).status, 404);

  const directory = await mkdtemp(join(tmpdir(), "zelavis-plugin-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "input.json");
  await writeFile(file, JSON.stringify(input));
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const output = [];
  globalThis.fetch = fetcher;
  console.log = (value) => output.push(value);
  try {
    await runPluginsCommand(["seotool", "audits", "create", "--file", file, "--url", "http://localhost/custom", "--json"]);
    assert.deepEqual(JSON.parse(output.pop()), expected);

    // Test --flag=value and --data inline JSON payload
    await runPluginsCommand(["seotool", "audits", "create", `--data=${JSON.stringify(input)}`, "--url=http://localhost/custom"]);
    assert.deepEqual(JSON.parse(output.pop()), expected);

    // Test standard input stream with --data-stdin
    const stdinStream = Readable.from([JSON.stringify(input)]);
    await runPluginsCommand(["seotool", "audits", "create", "--data-stdin", "--url=http://localhost/custom"], { stdin: stdinStream });
    assert.deepEqual(JSON.parse(output.pop()), expected);

    // Test standard input stream with --file -
    const fileStdinStream = Readable.from([JSON.stringify(input)]);
    await runPluginsCommand(["seotool", "audits", "create", "--file", "-", "--url=http://localhost/custom"], { stdin: fileStdinStream });
    assert.deepEqual(JSON.parse(output.pop()), expected);

    // Test conflicting payload inputs
    await assert.rejects(
      runPluginsCommand(["seotool", "audits", "create", "--file", file, "--data", "{}", "--url=http://localhost/custom"]),
      /only one/,
    );

    // Test invalid JSON in --data
    await assert.rejects(
      runPluginsCommand(["seotool", "audits", "create", "--data", "invalid-json", "--url=http://localhost/custom"]),
      /Invalid JSON/,
    );

    await writeFile(file, "{}");
    await assert.rejects(runPluginsCommand(["seotool", "audits", "create", "--file", file, "--url", "http://localhost/custom"]), (error) => error.response.status === 400);
    await runPluginsCommand(["seotool", "--help", "--url", "http://localhost/custom"]);
    assert.equal(JSON.parse(output.pop()).operations[0].resource, "audits");
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});
