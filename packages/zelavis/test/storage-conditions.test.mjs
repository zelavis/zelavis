// Conditional writes, and the probe that checks a store keeps them.
//
// A lease, a fence or an authoritative publication is only as good as the
// store's conditional write. Stores advertise "S3-compatible" and some accept
// `If-None-Match` / `If-Match` and ignore them; that fails late and silently,
// as two owners of one thing. The probe asks the store directly, and these
// tests hold it to telling an honest store from each way of being dishonest.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createS3CompatibleFileStorage,
  probeFileStorageGuarantees,
  ZelavisStorageConditionError,
} from "zelavis";
import { createLocalFileStorage } from "../dist/adapters/_shared.js";

const LOCAL_ADAPTER = new URL("../dist/adapters/_shared.js", import.meta.url).href;
const decoder = new TextDecoder();

/**
 * An in-memory S3 endpoint. `honest` enforces conditions; `ignoresConditions`
 * accepts the headers and writes regardless; `failsConditions` answers every
 * conditional write with a server error.
 */
function fakeS3(mode = "honest") {
  const objects = new Map();
  const requests = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
    const headers = new Headers(init.headers);
    const method = init.method ?? "GET";
    requests.push({ method, key, ifNoneMatch: headers.get("if-none-match"), ifMatch: headers.get("if-match") });
    const current = objects.get(key);

    if (method === "PUT") {
      const conditional = headers.has("if-none-match") || headers.has("if-match");
      if (conditional && mode === "failsConditions") return new Response(null, { status: 500 });
      if (mode === "notFoundOnCreate" && headers.get("if-none-match") === "*" && !current) {
        return new Response(null, { status: 404 });
      }
      if (headers.has("if-match") && !current) return new Response(null, { status: 404 });
      if (mode === "honest") {
        if (headers.get("if-none-match") === "*" && current) return new Response(null, { status: 412 });
        if (headers.has("if-match") && current?.etag !== headers.get("if-match")) {
          return new Response(null, { status: 412 });
        }
      }
      const body = new Uint8Array(init.body ?? new ArrayBuffer(0));
      const etag = `"${createHash("md5").update(body).digest("hex")}"`;
      objects.set(key, { body, etag });
      return new Response(null, { status: 200, headers: { etag } });
    }
    if (!current) return new Response(null, { status: 404 });
    if (method === "HEAD") return new Response(null, { status: 200, headers: { etag: current.etag } });
    if (method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response(current.body, {
      status: 200,
      headers: { etag: current.etag, "content-length": String(current.body.byteLength) },
    });
  };
  const storage = createS3CompatibleFileStorage({
    bucket: "b",
    region: "us-east-1",
    accessKeyId: "k",
    secretAccessKey: "s",
    endpoint: "https://storage.example.com",
    fetch,
  });
  return { storage, objects, requests };
}

const localDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-storage-conditions-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("an S3 store that enforces conditions passes, and is sent the conditions", async () => {
  const { storage, objects, requests } = fakeS3("honest");
  assert.deepEqual(await probeFileStorageGuarantees(storage), { conformant: true });
  const conditional = requests.filter((r) => r.method === "PUT");
  assert.deepEqual(conditional.map((r) => (r.ifNoneMatch ? `none-match ${r.ifNoneMatch}` : "match")),
    ["none-match *", "none-match *", "match", "match"]);
  assert.equal(objects.size, 0, "the probe left its object behind");
});

test("an S3 store that accepts conditions and ignores them fails, naming why", async () => {
  const { storage } = fakeS3("ignoresConditions");
  const result = await probeFileStorageGuarantees(storage);
  assert.equal(result.conformant, false);
  assert.match(result.violation, /does not enforce it/);
});

test("a store that answers a condition with a server error is inconclusive, never conformant", async () => {
  const { storage } = fakeS3("failsConditions");
  await assert.rejects(probeFileStorageGuarantees(storage), /could not complete step 1/);
});

test("an S3 write whose condition fails rejects with the condition, and a write reports its version", async () => {
  const { storage } = fakeS3("honest");
  const first = await storage.put({ path: "lease.json", body: "a", condition: { ifAbsent: true } });
  assert.match(first.etag, /^".+"$/);
  await assert.rejects(storage.put({ path: "lease.json", body: "b", condition: { ifAbsent: true } }),
    (error) => error instanceof ZelavisStorageConditionError && error.path === "lease.json");
  const second = await storage.put({ path: "lease.json", body: "c", condition: { ifMatch: first.etag } });
  await assert.rejects(storage.put({ path: "lease.json", body: "d", condition: { ifMatch: first.etag } }),
    ZelavisStorageConditionError);
  const read = await storage.get("lease.json");
  assert.equal(decoder.decode(read.body), "c");
  assert.equal(read.etag, second.etag);
});

test("local storage passes the probe and leaves nothing behind", async (t) => {
  const dir = localDir(t);
  const storage = createLocalFileStorage(dir);
  assert.deepEqual(await probeFileStorageGuarantees(storage), { conformant: true });
  assert.deepEqual(readdirSync(dir), []);
});

test("a storage that drops the condition fails the probe", async (t) => {
  const local = createLocalFileStorage(localDir(t));
  const careless = { ...local, put: ({ condition, ...rest }) => local.put(rest) };
  const result = await probeFileStorageGuarantees(careless);
  assert.equal(result.conformant, false);
  assert.match(result.violation, /does not enforce it/);
});

test("local: of many concurrent creates in one process, exactly one wins", async (t) => {
  const storage = createLocalFileStorage(localDir(t));
  const outcomes = await Promise.allSettled(Array.from({ length: 24 }, (_, i) =>
    storage.put({ path: "owner.json", body: `writer-${i}`, condition: { ifAbsent: true } })));
  const won = outcomes.filter((o) => o.status === "fulfilled");
  assert.equal(won.length, 1);
  assert.ok(outcomes.filter((o) => o.status === "rejected")
    .every((o) => o.reason instanceof ZelavisStorageConditionError));
  const stored = decoder.decode((await storage.get("owner.json")).body);
  assert.equal(stored, `writer-${outcomes.indexOf(won[0])}`, "the stored object is not the winner's");
});

test("local: of many concurrent creates across processes, exactly one wins", async (t) => {
  const dir = localDir(t);
  const race = (i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      const { createLocalFileStorage } = await import(${JSON.stringify(LOCAL_ADAPTER)});
      const storage = createLocalFileStorage(${JSON.stringify(dir)});
      try {
        await storage.put({ path: "owner.json", body: "process-${i}", condition: { ifAbsent: true } });
        console.log("won");
      } catch (error) {
        console.log(error.name === "ZelavisStorageConditionError" ? "lost" : "error " + error.message);
      }
    `], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", reject);
    child.on("close", () => resolve(out.trim()));
  });
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => race(i)));
  assert.deepEqual(results.filter((r) => r !== "won" && r !== "lost"), [], "a racer failed outright");
  assert.equal(results.filter((r) => r === "won").length, 1, `winners: ${results.join(", ")}`);
});

test("local: of many concurrent updates from one version, exactly one wins", async (t) => {
  const storage = createLocalFileStorage(localDir(t));
  const base = await storage.put({ path: "lease.json", body: "epoch-1" });
  const outcomes = await Promise.allSettled(Array.from({ length: 24 }, (_, i) =>
    storage.put({ path: "lease.json", body: `epoch-2-by-${i}`, condition: { ifMatch: base.etag } })));
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
  assert.deepEqual((await storage.list()).map((entry) => entry.path), ["lease.json"],
    "a staged file was listed as an object");
});

test("an update conditional on an object that is gone rejects as a failed condition", async () => {
  const { storage } = fakeS3("honest");
  await assert.rejects(storage.put({ path: "gone.json", body: "x", condition: { ifMatch: '"stale"' } }),
    ZelavisStorageConditionError);
});

test("a store that answers a create of an absent object with 404 is inconclusive, not conformant", async () => {
  const { storage } = fakeS3("notFoundOnCreate");
  await assert.rejects(probeFileStorageGuarantees(storage), (error) =>
    /could not complete step 1/.test(error.message) && /\(404\)/.test(error.cause?.message));
});
