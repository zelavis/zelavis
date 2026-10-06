import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { restoreHostPackagePolicy } from "../dist/adapters/_host-package-policy.js";
const sha = (body) => createHash("sha256").update(body).digest("hex");
async function fixture(t, hadOriginal = true) {
  const root = await mkdtemp(join(tmpdir(), "zelavis-package-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "state"), policy = join(root, "policy-rc.d");
  await mkdir(state, { mode: 0o700 });
  const wrapper = "#!/bin/sh\nexit 0\n", original = "#!/bin/sh\nexit 42\n";
  await writeFile(policy, wrapper, { mode: 0o755 });
  await writeFile(`${policy}.zelavis-owner`, `${state}\n`, { mode: 0o600 });
  await writeFile(join(state, "policy.digest"), sha(wrapper), { mode: 0o600 });
  await writeFile(join(state, "policy.had-original"), hadOriginal ? "yes" : "no", { mode: 0o600 });
  await writeFile(join(state, "policy.original-digest"), sha(original), { mode: 0o600 });
  if (hadOriginal) await writeFile(`${policy}.zelavis-original`, original, { mode: 0o755 });
  return { root, state, policy, wrapper, original };
}
test("complete uninstall restores the exact original policy, including relative symlinks", async (t) => {
  const f = await fixture(t);
  await rm(`${f.policy}.zelavis-original`);
  await writeFile(join(f.root, "operator-policy"), f.original);
  await symlink("operator-policy", `${f.policy}.zelavis-original`);
  await restoreHostPackagePolicy(f.state, f.policy);
  assert.equal((await lstat(f.policy)).isSymbolicLink(), true);
  assert.equal(await readFile(f.policy, "utf8"), f.original);
  await assert.rejects(lstat(`${f.policy}.zelavis-owner`), { code: "ENOENT" });
});
test("uninstall removes a policy created by Zelavis and leaves an operator edit intact", async (t) => {
  const f = await fixture(t, false);
  await restoreHostPackagePolicy(f.state, f.policy);
  await assert.rejects(lstat(f.policy), { code: "ENOENT" });
  const edited = await fixture(t);
  await writeFile(edited.policy, "operator edit");
  assert.match(await restoreHostPackagePolicy(edited.state, edited.policy), /Retaining operator-modified/);
  assert.equal(await readFile(edited.policy, "utf8"), "operator edit");
  assert.equal(await readFile(`${edited.policy}.zelavis-original`, "utf8"), edited.original);
  await assert.rejects(lstat(`${edited.policy}.zelavis-owner`), { code: "ENOENT" });
});
test("interruption before moving the original leaves it intact; foreign or writable inventories are refused", async (t) => {
  const f = await fixture(t);
  await rm(`${f.policy}.zelavis-original`);
  await writeFile(f.policy, f.original);
  await restoreHostPackagePolicy(f.state, f.policy);
  assert.equal(await readFile(f.policy, "utf8"), f.original);
  const foreign = await fixture(t);
  await restoreHostPackagePolicy(`${foreign.state}-other`, foreign.policy);
  assert.equal(await readFile(foreign.policy, "utf8"), foreign.wrapper);
  await chmod(join(foreign.state, "policy.digest"), 0o666);
  await assert.rejects(restoreHostPackagePolicy(foreign.state, foreign.policy), /Cannot prove/);
});


test("interrupted atomic policy writes are included in the uninstall inventory", async (t) => {
  const f = await fixture(t);
  await writeFile(`${f.policy}.new`, f.wrapper);
  await restoreHostPackagePolicy(f.state, f.policy);
  await assert.rejects(lstat(`${f.policy}.new`), { code: "ENOENT" });
  const pending = await fixture(t, false);
  await rename(`${pending.policy}.zelavis-owner`, `${pending.policy}.zelavis-owner.new`);
  await restoreHostPackagePolicy(pending.state, pending.policy);
  await assert.rejects(lstat(`${pending.policy}.zelavis-owner.new`), { code: "ENOENT" });
  assert.equal(await readFile(pending.policy, "utf8"), pending.wrapper, "unrecorded policy ownership is never inferred");
});
