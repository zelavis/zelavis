import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// A Bun Project's runtime store is backed up like a Node Project's: `VACUUM INTO` through the host's own SQLite
// binding. Run under real Bun; skipped where Bun is not installed.
const bun = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;

test("the runtime-store backup component copies a live SQLite file under Bun", { skip: !bun && "bun is not installed" }, () => {
  const child = spawnSync("bun", [new URL("./fixtures/bun-sqlite-backup-check.mjs", import.meta.url).pathname], { encoding: "utf8", timeout: 60_000 });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const seen = JSON.parse(child.stdout.trim().split("\n").at(-1));
  assert.deepEqual(seen, { runtime: "bun", rows: [{ key: "session", value: "kept" }] });
});
