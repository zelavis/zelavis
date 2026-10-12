import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateHostOperationManifest } from "../../packages/zelavis/dist/core/deployment/index.js";

const directory = fileURLToPath(new URL("../operations/zelavis.container-probe/v1/", import.meta.url));
const artifact = await readFile(join(directory, "artifact"), "utf8");
const manifest = JSON.parse(await readFile(join(directory, "operation.json"), "utf8"));

const run = (script) => JSON.parse(execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" }));

test("the probe's manifest is a valid, bounded, read-only host operation", () => {
  const checked = validateHostOperationManifest({ ...manifest, sha256: createHash("sha256").update(artifact).digest("hex") });
  assert.equal(checked.id, "zelavis.container-probe");
  assert.deepEqual(manifest.arguments, {}, "it takes nothing from a caller");
  assert.equal(manifest.authorization.permission, "server.host.report", "reading facts needs the same permission as the host report");
  assert.ok(manifest.result.maxBytes <= 1024);
  assert.doesNotMatch(artifact, /docker (run|rm|pull|stop|kill|exec|build|create|start)/, "it only looks");
});

test("it reports a working engine as facts and a missing one as absence", async (t) => {
  const here = run(artifact);
  assert.equal(here.schema, 1);
  assert.equal(typeof here.installed, "boolean");
  assert.equal(typeof here.reachable, "boolean");
  if (!here.installed) assert.equal(here.reachable, false);
  if (here.reachable) {
    assert.match(here.version, /^[0-9][A-Za-z0-9._+-]*$/);
    assert.equal(typeof here.rootless, "boolean");
    assert.ok(Number.isInteger(here.runningBuilds) && here.runningBuilds >= 0);
  }

  // The same program on a PATH that holds no docker: nothing is installed, so nothing else is known.
  const temporary = await mkdtemp(join(tmpdir(), "zv-probe-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const file = join(temporary, "probe");
  await writeFile(file, artifact.replace(/^PATH=.*$/m, "PATH=/usr/bin:/bin"));
  const absent = JSON.parse(execFileSync("/bin/sh", [file], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }));
  if (!execFileSync("/bin/sh", ["-c", "command -v docker || true"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }).trim()) {
    assert.deepEqual(absent, { schema: 1, installed: false, reachable: false, version: null, rootless: null, runningBuilds: null });
  }
});
