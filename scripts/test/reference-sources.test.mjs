import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReferences, convexAuthOrigin, effectOrigin, effectVersion, syncReferences } from "../reference-sources.mjs";

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "zelavis-refs-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const upstream = join(base, "upstream");
  const authUpstream = join(base, "convex-auth");
  for (const path of [root, upstream, authUpstream]) { mkdirSync(path); git(["init", "--quiet"], path); }
  writeFileSync(join(authUpstream, "LICENSE"), "Apache-2.0\n");
  git(["add", "."], authUpstream);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "fixture"], authUpstream);
  const authCommit = git(["rev-parse", "HEAD"], authUpstream);
  mkdirSync(join(upstream, "packages/effect"), { recursive: true });
  json(join(upstream, "packages/effect/package.json"), { version: "4.0.0" });
  git(["add", "."], upstream);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "fixture"], upstream);
  mkdirSync(join(root, "scripts"));
  const commit = git(["rev-parse", "HEAD"], upstream);
  git(["tag", "effect@4.0.0"], upstream);
  json(join(root, "package.json"), { dependencies: { effect: "4.0.0" } });
  git(["add", "package.json"], root);
  const convexAuth = { url: convexAuthOrigin, commit: authCommit };
  json(join(root, "scripts/reference-sources.json"), { effect: { url: effectOrigin, version: "4.0.0", commit }, "convex-auth": convexAuth });
  // All Git operations run for real; only the remote origins are redirected to
  // these local fixtures so failures and updates need no network or credentials.
  const localGit = (args, cwd) => git(args.map((arg) => arg === effectOrigin ? upstream : arg === convexAuthOrigin ? authUpstream : arg), cwd);
  return { root, upstream, authUpstream, commit, convexAuth, localGit };
}

test("missing source is optional, while exact workspace pins remain mandatory", (t) => {
  const { root } = fixture(t);
  assert.match(checkReferences(root), /Optional source is absent/);
  json(join(root, "package.json"), { dependencies: { effect: "^4.0.0" } });
  assert.throws(() => checkReferences(root), /exact versions/);
});

test("rejects conflicting workspace pins and excludes reference manifests", (t) => {
  const { root } = fixture(t);
  mkdirSync(join(root, "packages/other"), { recursive: true });
  json(join(root, "packages/other/package.json"), { optionalDependencies: { effect: "4.0.1" } });
  git(["add", "packages"], root);
  assert.throws(() => effectVersion(root), /Conflicting Effect pins/);
});

test("fetches the pinned commit, validates the checkout, and skips matching downloads", (t) => {
  const { root, localGit } = fixture(t);
  assert.match(syncReferences(root, localGit), /Synced Effect 4.0.0/);
  assert.match(checkReferences(root), /Local Effect reference matches/);
  assert.match(syncReferences(root, () => { throw new Error("Unexpected download"); }), /no download needed/);
});

test("derives upgraded version and records the exact release commit", (t) => {
  const { root, upstream, localGit } = fixture(t);
  syncReferences(root, localGit);
  json(join(upstream, "packages/effect/package.json"), { version: "4.0.1" });
  git(["add", "."], upstream);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "upgrade"], upstream);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "tag", "-a", "effect@4.0.1", "-m", "release"], upstream);
  json(join(root, "package.json"), { dependencies: { effect: "4.0.1" } });
  assert.throws(() => checkReferences(root), /Reference record is 4.0.0/);
  syncReferences(root, localGit);
  const record = JSON.parse(readFileSync(join(root, "scripts/reference-sources.json"), "utf8")).effect;
  assert.equal(record.version, "4.0.1");
  assert.equal(record.commit, git(["rev-parse", "HEAD"], upstream));
  assert.match(checkReferences(root), /matches 4.0.1/);
});

test("preserves local edits and untracked files", (t) => {
  const { root, localGit } = fixture(t);
  syncReferences(root, localGit);
  const path = join(root, "repos/effect/notes.txt");
  writeFileSync(path, "local work");
  assert.throws(() => syncReferences(root, localGit), /local changes or extra files/);
  assert.equal(readFileSync(path, "utf8"), "local work");
  assert.throws(() => checkReferences(root), /local changes or extra files/);
});

test("failed fetch preserves the previous checkout and reference record", (t) => {
  const { root, commit, localGit } = fixture(t);
  syncReferences(root, localGit);
  json(join(root, "package.json"), { dependencies: { effect: "4.0.1" } });
  const record = readFileSync(join(root, "scripts/reference-sources.json"), "utf8");
  const failingGit = (args, cwd) => {
    if (args[0] === "ls-remote") return `${commit}\trefs/tags/effect@4.0.1`;
    if (args.includes("fetch")) throw new Error("Offline");
    return localGit(args, cwd);
  };
  assert.throws(() => syncReferences(root, failingGit), /Offline/);
  assert.equal(git(["rev-parse", "HEAD"], join(root, "repos/effect")), commit);
  assert.equal(readFileSync(join(root, "scripts/reference-sources.json"), "utf8"), record);
  assert.equal(existsSync(join(root, "repos/.refs-sync.lock")), false);
});

test("preserves locally committed changes rather than treating them as an upgrade", (t) => {
  const { root, localGit } = fixture(t);
  syncReferences(root, localGit);
  const checkout = join(root, "repos/effect");
  writeFileSync(join(checkout, "notes.txt"), "committed local work");
  git(["add", "."], checkout);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "local work"], checkout);
  const head = git(["rev-parse", "HEAD"], checkout);
  assert.throws(() => syncReferences(root, localGit), /local commits/);
  assert.equal(git(["rev-parse", "HEAD"], checkout), head);
});

test("refuses a release whose package version is wrong before replacing source", (t) => {
  const { root, commit, localGit } = fixture(t);
  syncReferences(root, localGit);
  json(join(root, "package.json"), { dependencies: { effect: "4.0.1" } });
  const wrongReleaseGit = (args, cwd) => args[0] === "ls-remote" ? `${commit}\trefs/tags/effect@4.0.1` : localGit(args, cwd);
  assert.throws(() => syncReferences(root, wrongReleaseGit), /does not match/);
  assert.equal(git(["rev-parse", "HEAD"], join(root, "repos/effect")), commit);
});

test("rejects unofficial origins and preserves unmanaged source directories", (t) => {
  const { root, commit, convexAuth } = fixture(t);
  json(join(root, "scripts/reference-sources.json"), { effect: { url: "https://example.com/effect.git", version: "4.0.0", commit }, "convex-auth": convexAuth });
  assert.throws(() => checkReferences(root), /official HTTPS origin/);
  json(join(root, "scripts/reference-sources.json"), { effect: { url: effectOrigin, version: "4.0.0", commit }, "convex-auth": { ...convexAuth, url: "https://example.com/convex-auth.git" } });
  assert.throws(() => checkReferences(root), /Invalid convex-auth reference record/);
  json(join(root, "scripts/reference-sources.json"), { effect: { url: effectOrigin, version: "4.0.0", commit }, "convex-auth": convexAuth });
  mkdirSync(join(root, "repos/effect"), { recursive: true });
  assert.throws(() => syncReferences(root), /not a managed Git checkout/);
});

test("serializes concurrent syncs without removing another sync's lock", (t) => {
  const { root } = fixture(t);
  mkdirSync(join(root, "repos/.refs-sync.lock"), { recursive: true });
  assert.throws(() => syncReferences(root), /EEXIST/);
  assert.ok(existsSync(join(root, "repos/.refs-sync.lock")));
});

test("pins convex-auth by commit and refuses a modified checkout", (t) => {
  const { root, authUpstream, convexAuth, localGit } = fixture(t);
  assert.match(checkReferences(root), /Optional convex-auth source is absent/);
  assert.match(syncReferences(root, localGit), /Synced convex-auth/);
  const checkout = join(root, "repos/convex-auth");
  assert.equal(git(["rev-parse", "HEAD"], checkout), convexAuth.commit);
  assert.match(checkReferences(root), /Local convex-auth reference matches/);
  assert.match(syncReferences(root, () => { throw new Error("Unexpected download"); }), /convex-auth reference already matches/);
  writeFileSync(join(checkout, "LICENSE"), "edited\n");
  assert.throws(() => syncReferences(root, localGit), /repos\/convex-auth has local changes or extra files/);
  assert.throws(() => checkReferences(root), /repos\/convex-auth has local changes or extra files/);
  assert.equal(readFileSync(join(checkout, "LICENSE"), "utf8"), "edited\n");
  git(["checkout", "--", "LICENSE"], checkout);
  // A newer pin replaces a clean checkout.
  writeFileSync(join(authUpstream, "NEW.md"), "new\n");
  git(["add", "."], authUpstream);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "next"], authUpstream);
  const next = git(["rev-parse", "HEAD"], authUpstream);
  const record = JSON.parse(readFileSync(join(root, "scripts/reference-sources.json"), "utf8"));
  json(join(root, "scripts/reference-sources.json"), { ...record, "convex-auth": { url: convexAuthOrigin, commit: next } });
  assert.throws(() => checkReferences(root), /does not match/);
  syncReferences(root, localGit);
  assert.equal(git(["rev-parse", "HEAD"], checkout), next);
});

test("Effect pins follow working-tree package additions and removals before staging", t => {
  const { root } = fixture(t);
  const manifest = join(root, "packages/retired/package.json");
  mkdirSync(join(root, "packages/retired"), { recursive: true });
  json(manifest, { devDependencies: { effect: "4.0.0" } });
  git(["add", "packages"], root);
  rmSync(manifest);
  assert.equal(effectVersion(root), "4.0.0", "a removed package no longer participates");
  const addition = join(root, "packages/new");
  mkdirSync(addition);
  json(join(addition, "package.json"), { dependencies: { effect: "4.0.1" } });
  assert.throws(() => effectVersion(root), /Conflicting Effect pins/, "new unstaged packages are checked");
});
