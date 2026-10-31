// Copying media in from another system's storage: a page at a time in path order, under a prefix, with each
// file's SHA-256 recorded, skipping what is already here, so a repeated or resumed import copies nothing twice.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalFileStorage } from "../dist/adapters/_shared.js";
import { copyStorageFiles, resolveStorageEndpointGroup } from "../dist/platform/storage.js";

const scratch = (t) => { const d = mkdtempSync(join(tmpdir(), "zv-media-import-")); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };

test("files are copied in pages, skipped when already here, and resumed from next", async (t) => {
  const from = createLocalFileStorage(scratch(t)), to = createLocalFileStorage(scratch(t));
  for (const name of ["a.png", "b.png", "c.png", "docs/readme.txt"]) await from.put({ path: `uploads/${name}`, body: new TextEncoder().encode(`bytes of ${name}`), contentType: "image/png" });
  const first = await copyStorageFiles(from, to, { prefix: "uploads/", into: "imported", limit: 2, origin: "s3://old" });
  assert.deepEqual([first.copied, first.skipped, first.next], [2, 0, "uploads/b.png"]);
  const rest = await copyStorageFiles(from, to, { prefix: "uploads/", into: "imported", after: first.next, limit: 10, origin: "s3://old" });
  assert.deepEqual([rest.copied, rest.next], [2, undefined]);
  const copied = await to.get("imported/uploads/docs/readme.txt");
  assert.equal(new TextDecoder().decode(copied.body), "bytes of docs/readme.txt");
  assert.equal(copied.metadata["imported-from"], "s3://old/uploads/docs/readme.txt");
  const again = await copyStorageFiles(from, to, { prefix: "uploads/", into: "imported", limit: 10, origin: "s3://old" });
  assert.deepEqual([again.copied, again.skipped], [0, 4], "a repeated import copies nothing twice");
  await from.put({ path: "uploads/a.png", body: new TextEncoder().encode("changed") });
  assert.equal((await copyStorageFiles(from, to, { prefix: "uploads/", into: "imported", limit: 10, origin: "s3://old" })).copied, 1, "a changed file is copied again");
});

test("the import route refuses a source it cannot read safely", async (t) => {
  const group = await resolveStorageEndpointGroup({ storage: createLocalFileStorage(scratch(t)) }, { rootPath: "/zelavis", apiPrefix: "/zelavis/api", apiVersion: "v1" });
  const route = group.api.v1.find((entry) => entry.id === "storage.import");
  for (const [body, reason] of [[{ source: { kind: "url", url: "http://169.254.169.254/" } }, /kind: "s3"/], [{ source: { kind: "s3", bucket: "b", region: "r", accessKeyId: "k" } }, /secretAccessKey/], [{ source: { kind: "s3", bucket: "b", region: "r", accessKeyId: "k", secretAccessKey: "s" }, limit: 0 }, /limit is 1 to 500/]]) {
    const answer = await route.handler({ body });
    assert.equal(answer.status, 400);
    assert.match(answer.body.error, reason);
  }
});
