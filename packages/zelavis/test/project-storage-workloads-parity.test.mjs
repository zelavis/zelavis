// An App Project's files and workloads through the route's own handler, the SDK and the CLI: each against a service of its own,
// the same scenario has to answer the same, refusals included.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveStorageEndpointGroup } from "../dist/platform/storage.js";
import { workloadsEndpointGroup, createMemoryWorkloadsStore } from "../dist/app/workloads/workloads-service.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runStorageCommand } from "../dist/cli/storage.js";
import { runWorkloadsCommand } from "../dist/cli/workloads.js";
import { fakePlatform, routeTable, runCli, steady } from "./_platform.mjs";

const BASE = "http://zv.test/zelavis";
const PREFIX = "/zelavis/api/v1/runtime/projects/p1/proxy/zelavis/api/v1";
const operator = { id: "operator", type: "user", permissions: ["storage.read", "storage.write", "workloads.view", "workloads.manage", "workloads.logs.read"] };

const memoryStorage = () => {
  const held = new Map();
  return {
    list: (prefix) => [...held.values()].filter((file) => !prefix || file.path.startsWith(prefix)),
    get: (path) => held.get(path),
    put: (input) => { const file = { ...input, size: input.body.byteLength, updatedAt: new Date(0) }; held.set(input.path, file); return file; },
    delete: (path) => held.delete(path),
  };
};

const platformFor = async () => fakePlatform({
  prefix: PREFIX,
  principal: operator,
  routes: routeTable([
    await resolveStorageEndpointGroup({ storage: memoryStorage() }, { rootPath: "/zelavis", apiPrefix: "/api", apiVersion: "v1" }),
    workloadsEndpointGroup({ store: createMemoryWorkloadsStore() }),
  ]),
});

const outcome = async (run) => {
  try { return { answer: steady(await run()) }; }
  catch (error) { return { refused: String(error?.body?.error ?? error?.message ?? error) }; }
};

test("an App Project's files come out the same through the handler, the SDK and the CLI, refusals included", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "zv-storage-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "source.bin");
  writeFileSync(source, Uint8Array.of(0, 255, 1, 254));
  const target = join(directory, "copy.bin");
  const results = {};
  for (const surface of ["http", "sdk", "cli"]) {
    const fetchImplementation = await platformFor();
    const client = createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: fetchImplementation }).storage("p1");
    const cli = (args) => runCli(runStorageCommand, [...args, "--project", "p1", "--url", BASE, "--json"], fetchImplementation).then(JSON.parse);
    const call = fetchImplementation;
    const http = {
      write: async (path, text, headers = {}) => (await call(`http://zv.test${PREFIX}/storage/files/${path}`, { method: "PUT", body: text, headers })).json(),
      list: async (prefix) => (await call(`http://zv.test${PREFIX}/storage/files${prefix ? `?prefix=${prefix}` : ""}`)).json(),
      meta: async (path) => (await call(`http://zv.test${PREFIX}/storage/files/${path}?format=metadata`)).json(),
      read: async (path) => { const response = await call(`http://zv.test${PREFIX}/storage/files/${path}`); if (!response.ok) throw Object.assign(new Error(), { body: await response.json() }); return { text: await response.text(), contentType: response.headers.get("content-type") }; },
      delete: async (path) => { const response = await call(`http://zv.test${PREFIX}/storage/files/${path}`, { method: "DELETE" }); const body = await response.json(); if (!response.ok) throw Object.assign(new Error(), { body }); return body; },
    };
    const steps = {
      http: [
        () => http.write("docs/a.txt", "hello", { "content-type": "text/plain", "x-file-meta-label": "greeting" }),
        () => http.write("docs/b.txt", "second", { "content-type": "text/plain" }),
        () => http.list("docs/"),
        () => http.meta("docs/a.txt"),
        () => http.read("docs/a.txt"),
        () => http.read("docs/missing.txt"),
        () => http.delete("docs/b.txt"),
        () => http.delete("docs/b.txt"),
        () => http.list(),
      ],
      sdk: [
        () => client.write("docs/a.txt", "hello", { contentType: "text/plain", metadata: { label: "greeting" } }),
        () => client.write("docs/b.txt", "second", { contentType: "text/plain" }),
        () => client.list("docs/"),
        () => client.metadata("docs/a.txt"),
        async () => { const file = await client.read("docs/a.txt"); return { text: new TextDecoder().decode(file.bytes), contentType: file.contentType }; },
        () => client.read("docs/missing.txt"),
        () => client.delete("docs/b.txt"),
        () => client.delete("docs/b.txt"),
        () => client.list(),
      ],
      cli: [
        () => cli(["put", "docs/a.txt", "--text", "hello", "--content-type", "text/plain", "--metadata", JSON.stringify({ label: "greeting" })]),
        () => cli(["put", "docs/b.txt", "--text", "second", "--content-type", "text/plain"]),
        () => cli(["list", "docs/"]),
        () => cli(["metadata", "docs/a.txt"]),
        async () => { const file = await cli(["get", "docs/a.txt"]); return { text: file.content, contentType: file.contentType }; },
        () => cli(["get", "docs/missing.txt"]),
        () => cli(["delete", "docs/b.txt"]),
        () => cli(["delete", "docs/b.txt"]),
        () => cli(["list"]),
      ],
    };
    results[surface] = [];
    for (const step of steps[surface]) results[surface].push(await outcome(step));
    // Bytes that are not text survive a trip through a file: --file in, --output out.
    if (surface === "cli") {
      await cli(["put", "bin/raw", "--file", source]);
      const summary = await cli(["get", "bin/raw", "--output", target]);
      assert.deepEqual([...readFileSync(target)], [0, 255, 1, 254]);
      assert.equal(summary.size, 4);
    } else if (surface === "sdk") {
      await client.write("bin/raw", Uint8Array.of(0, 255, 1, 254));
      assert.deepEqual([...(await client.read("bin/raw")).bytes], [0, 255, 1, 254]);
    }
  }
  const [firstWrite, , listed, , read, missing] = results.http;
  assert.equal(firstWrite.answer.file.path, "docs/a.txt");
  assert.equal(listed.answer.files.length, 2);
  assert.equal(read.answer.text, "hello");
  assert.match(missing.refused, /not found/i);
  // The answers are the same: the SDK's and the CLI's are the handler's own, bar how a read hands over its bytes.
  const comparable = (list) => list.map((entry) => entry.answer ?? { refused: entry.refused });
  assert.deepEqual(comparable(results.sdk).filter((_, at) => at !== 4), comparable(results.http).filter((_, at) => at !== 4));
  assert.deepEqual(comparable(results.cli).filter((_, at) => at !== 4), comparable(results.http).filter((_, at) => at !== 4));
  assert.deepEqual(results.sdk[4], results.http[4]);
  assert.deepEqual(results.cli[4], results.http[4]);
});

test("an App Project's workloads come out the same through the handler, the SDK and the CLI, refusals included", async () => {
  const results = {};
  for (const surface of ["http", "sdk", "cli"]) {
    const fetchImplementation = await platformFor();
    const client = createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: fetchImplementation }).workloads("p1");
    const cli = (args) => runCli(runWorkloadsCommand, [...args, "--project", "p1", "--url", BASE, "--json"], fetchImplementation).then(JSON.parse);
    const raw = async (method, path, body) => {
      const response = await fetchImplementation(`http://zv.test${PREFIX}/workloads${path}`, { method, ...(body ? { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
      const answer = await response.json();
      if (!response.ok) throw Object.assign(new Error(), { body: answer });
      return answer;
    };
    const ids = {};
    const remember = (answer) => { ids.id = answer.id; return answer; };
    const code = 'export default () => new Response("ok")';
    const steps = {
      http: [
        () => raw("GET", "/health"),
        () => raw("POST", "", { projectId: "p1", type: "function", name: "Hello", code, route: "/hello" }).then(remember),
        () => raw("GET", "?projectId=p1"),
        () => raw("GET", "?projectId=p1&type=job"),
        () => raw("GET", `/${ids.id}`),
        () => raw("PUT", `/${ids.id}`, { name: "Hello again", enabled: false }),
        () => raw("POST", `/${ids.id}/run`, {}),
        () => raw("GET", `/logs?projectId=p1&workloadId=${ids.id}`),
        () => raw("GET", "/menu/functions"),
        () => raw("GET", "/nope"),
        () => raw("POST", "", { projectId: "p1", type: "bogus", name: "x" }),
      ],
      sdk: [
        () => client.health(),
        () => client.create({ type: "function", name: "Hello", code, route: "/hello" }).then(remember),
        () => client.list(),
        () => client.list({ type: "job" }),
        () => client.get(ids.id),
        () => client.update(ids.id, { name: "Hello again", enabled: false }),
        () => client.run(ids.id),
        () => client.logs({ workloadId: ids.id }),
        () => client.menu("functions"),
        () => client.get("nope"),
        () => client.create({ type: "bogus", name: "x" }),
      ],
      cli: [
        () => cli(["health"]),
        () => cli(["create", "--data", JSON.stringify({ type: "function", name: "Hello", code, route: "/hello" })]).then(remember),
        () => cli(["list"]),
        () => cli(["list", "--type", "job"]),
        () => cli(["get", ids.id]),
        () => cli(["update", ids.id, "--data", JSON.stringify({ name: "Hello again", enabled: false })]),
        () => cli(["run", ids.id]),
        () => cli(["logs", "--workload", ids.id]),
        () => cli(["menu", "functions"]),
        () => cli(["get", "nope"]),
        () => cli(["create", "--data", JSON.stringify({ type: "bogus", name: "x" })]),
      ],
    };
    results[surface] = [];
    for (const step of steps[surface]) results[surface].push(await outcome(step));
  }
  // The ids the service generates differ run to run, so they are named by what they point at.
  const normalized = (list) => JSON.parse(JSON.stringify(list).replace(/(fn|run)_[a-z0-9]+/g, "$1_ID"));
  assert.deepEqual(normalized(results.sdk), normalized(results.http));
  assert.deepEqual(normalized(results.cli), normalized(results.http));
  const [health, created, listed, jobs, , updated, ran, logs, menu, missing, invalid] = results.http;
  assert.ok(health.answer && created.answer.name === "hello", JSON.stringify(created));
  assert.equal(listed.answer.workloads.length, 1);
  assert.equal(jobs.answer.workloads.length, 0, "the type filter applies");
  assert.equal(updated.answer.enabled, false);
  assert.ok(ran.answer && logs.answer.logs.length === 1 && menu.answer, "a run is logged and read back");
  assert.ok(missing.refused && invalid.refused, "an unknown workload and an unknown type are refused");
});
