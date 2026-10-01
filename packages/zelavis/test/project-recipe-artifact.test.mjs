import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm, cp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Zelavis } from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import { resolveBundledServiceDirectory } from "../dist/adapters/_local-runtime.js";
import {
  loadRecipeArtifact,
  materializeRecipeArtifact,
  digestArtifactDirectory,
  RecipeArtifactError,
} from "../dist/adapters/_recipe-artifact.js";

const OWNER = { principal: { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] } };

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "zelavis-recipe-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function bundledApp() {
  const directory = resolveBundledServiceDirectory("@zelavis/app");
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  return { directory, manifest };
}

test("a materialized recipe loads only when it matches its locked digest", async () => {
  const data = await scratch();
  const { directory, manifest } = await bundledApp();
  const { digest } = await materializeRecipeArtifact(directory, data);
  const lock = { name: manifest.name, version: manifest.version, digest };

  const { service } = await loadRecipeArtifact(data, lock);
  assert.equal(service.name, "@zelavis/app");
  assert.equal(service.version, manifest.version);

  // Modified code is refused, not run.
  const entry = join(data, "recipe", "package", "dist", "index.js");
  await writeFile(entry, `${await readFile(entry, "utf8")}\n// tampered\n`);
  await assert.rejects(() => loadRecipeArtifact(data, lock), RecipeArtifactError);
});

test("a lock for a different version than the artifact is refused", async () => {
  const data = await scratch();
  const { directory, manifest } = await bundledApp();
  const { digest } = await materializeRecipeArtifact(directory, data);

  await assert.rejects(
    () => loadRecipeArtifact(data, { name: manifest.name, version: "0.0.1", digest }),
    /not the locked/,
  );
});

test("a digest depends on file contents, not directory order", async () => {
  const root = await scratch();
  const a = join(root, "a");
  const b = join(root, "b");
  for (const directory of [a, b]) await mkdir(directory, { recursive: true });
  await writeFile(join(a, "x.txt"), "1");
  await writeFile(join(a, "y.txt"), "2");
  await writeFile(join(b, "y.txt"), "2");
  await writeFile(join(b, "x.txt"), "1");
  assert.equal(await digestArtifactDirectory(a), await digestArtifactDirectory(b));
  await writeFile(join(b, "x.txt"), "changed");
  assert.notEqual(await digestArtifactDirectory(a), await digestArtifactDirectory(b));
});

test("a new Project freezes its recipe and keeps running it when the Platform's copy differs", async () => {
  const data = await scratch();
  const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: data }) });
  test.after(() => zv.close());

  const created = await zv.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "frozen", name: "Frozen", recipeName: "@zelavis/app", start: true }),
    }),
    OWNER,
  );
  assert.equal(created.status, 201);

  const projectFile = join(data, "projects", "frozen", "project.json");
  const record = JSON.parse(await readFile(projectFile, "utf8"));
  assert.equal(record.engine.createdWith, (await import("../dist/version.js")).ZELAVIS_VERSION);
  assert.match(record.recipe.artifact.digest, /^sha256:[0-9a-f]{64}$/);
  const packaged = JSON.parse(
    await readFile(join(data, "projects", "frozen", ".zelavis", "recipe", "package", "package.json"), "utf8"),
  );
  assert.equal(packaged.version, record.recipe.version);

  // Simulate the Platform having moved on since this Project was created: its
  // frozen recipe is an older release that the Platform no longer bundles. The
  // System Store's lock and the descriptor both say so.
  const artifactRoot = join(data, "projects", "frozen", ".zelavis");
  const older = { ...packaged, version: "0.9.0" };
  await writeFile(join(artifactRoot, "recipe", "package", "package.json"), JSON.stringify(older));
  const digest = await digestArtifactDirectory(join(artifactRoot, "recipe", "package"));
  record.recipe.version = "0.9.0";
  record.recipe.artifact = { digest };
  record.engine = { createdWith: "0.0.9-engine" };
  await writeFile(projectFile, JSON.stringify(record, null, 2));
  const systemStore = zv.platform.resources.systemStore;
  const stored = await systemStore.get("projects", "frozen");
  await systemStore.set("projects", "frozen", {
    ...stored.value,
    recipe: { ...stored.value.recipe, version: "0.9.0" },
  });

  // Restart the Project: it must run the frozen 0.9.0, though this Platform
  // bundles a different version.
  const restarted = await zv.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/projects/frozen/restart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    OWNER,
  );
  assert.equal(restarted.status, 200, await restarted.clone().text());
  const config = await zv.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/projects/frozen/proxy/zelavis/api/v1/runtime/config"),
    OWNER,
  );
  const registry = (await config.json()).serviceRegistry;
  const app = registry.find((service) => service.name === "@zelavis/app");
  assert.equal(app?.version, "0.9.0");
  // A later Platform never rewrites which engine created the Project.
  const after = JSON.parse(await readFile(projectFile, "utf8"));
  assert.equal(after.engine.createdWith, "0.0.9-engine");
});

test("a Project locked to a version this Platform no longer ships, with no frozen copy, fails to prepare and says why", async () => {
  const data = await scratch();
  const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: data }) });
  test.after(() => zv.close());
  const call = (path, init) => zv.fetch(
    new Request(`http://localhost/zelavis/api/v1/runtime/projects${path}`, init), OWNER);
  const created = await call("", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "legacy", name: "Legacy", recipeName: "@zelavis/app", start: true }),
  });
  assert.equal(created.status, 201);

  // What a Project created before recipes were frozen looks like.
  const directory = join(data, "projects", "legacy");
  const projectFile = join(directory, "project.json");
  const record = JSON.parse(await readFile(projectFile, "utf8"));
  delete record.recipe.artifact;
  record.recipe.version = "0.0.1-old";
  await writeFile(projectFile, JSON.stringify(record, null, 2));
  await rm(join(directory, ".zelavis", "recipe"), { recursive: true, force: true });
  const systemStore = zv.platform.resources.systemStore;
  const stored = await systemStore.get("projects", "legacy");
  const lock = { ...stored.value.recipe, version: "0.0.1-old" };
  delete lock.artifact;
  await systemStore.set("projects", "legacy", { ...stored.value, recipe: lock });

  const restarted = await call("/legacy/restart", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.notEqual(restarted.status, 200);
  const project = (await (await call("/legacy")).json()).project;
  assert.equal(project.runtime.status, "failed");
  assert.match(project.runtime.error, /cannot be prepared: this Platform ships/);
  assert.match(project.runtime.error, /delete and recreate the Project/);
  assert.doesNotMatch(project.runtime.error, /prepare the Project again/);
});
