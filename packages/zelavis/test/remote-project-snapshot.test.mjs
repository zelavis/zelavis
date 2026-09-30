import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { packRemoteProjectSnapshot } from "../dist/adapters/_remote-project-snapshot.js";

async function preparedProject(t) {
  const projects = await mkdtemp(join(tmpdir(), "zv-snapshot-"));
  t.after(() => rm(projects, { recursive: true, force: true }));
  const root = join(projects, "p1");
  await mkdir(join(root, ".zelavis", "recipe", "package"), { recursive: true });
  await writeFile(join(root, "project.json"), "{}");
  await writeFile(join(root, ".zelavis", "recipe", "package", "package.json"), "{}");
  return { projects, root };
}

const paths = (packed) => JSON.parse(new TextDecoder().decode(packed.body)).files.map((file) => file.path);

test("the allow-list the Platform handed a Project does not travel with it, and does not block the snapshot", async (t) => {
  const { projects, root } = await preparedProject(t);
  await writeFile(join(root, ".zelavis", "allowlist.json"), "{}");

  const files = paths(await packRemoteProjectSnapshot(projects, "p1"));
  assert.equal(files.includes(".zelavis/allowlist.json"), false);
  assert.ok(files.includes("project.json"));
});

test("any other Project data under .zelavis still refuses the snapshot", async (t) => {
  const { projects, root } = await preparedProject(t);
  await mkdir(join(root, ".zelavis", "data"), { recursive: true });
  await writeFile(join(root, ".zelavis", "data", "shard.sqlite"), "x");

  await assert.rejects(packRemoteProjectSnapshot(projects, "p1"), /local runtime data/);
});
