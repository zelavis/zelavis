import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAuthProvenance, matchesOmitted, provenanceHeader } from "../auth-upstream.mjs";
import { repositoryRoot, sourceRecord } from "../reference-sources.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const readJSON = (path) => JSON.parse(readFileSync(path, "utf8"));
const pin = sourceRecord(repositoryRoot)["convex-auth"].commit;
const blob = "0".repeat(40);

test("the repository's derived Auth files and upstream.json agree", () => {
  const record = readJSON(join(repositoryRoot, "packages/zelavis/src/auth/upstream.json"));
  assert.deepEqual(checkAuthProvenance({ sourceRoot: join(repositoryRoot, "packages/zelavis/src"), record, pinnedCommit: pin }), []);
});

test("a file carrying the header without an entry fails (fixture)", () => {
  const fixture = join(here, "fixtures/auth-provenance/missing-entry");
  const problems = checkAuthProvenance({ sourceRoot: join(fixture, "src"), record: readJSON(join(fixture, "upstream.json")), pinnedCommit: pin });
  assert.deepEqual(problems, ['file "auth/core/sessions.ts" carries the provenance header but has no entry in upstream.json']);
});

function workspace(t, files) {
  const root = mkdtempSync(join(tmpdir(), "zelavis-auth-provenance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const derived = (upstream, commit = pin) => `${provenanceHeader(upstream, commit, "translated to Effect").join("\n")}\nexport {};\n`;
const record = (files) => ({ repository: "https://github.com/convex/convex-auth", commit: pin, files, omitted: [] });

test("a recorded file with a matching header passes", (t) => {
  const root = workspace(t, { "auth/core/sessions.ts": derived("packages/core/src/component/sessions.ts"), "auth/runtime/db.ts": "export {};\n" });
  assert.deepEqual(checkAuthProvenance({ sourceRoot: root, record: record([{ path: "auth/core/sessions.ts", upstream: "packages/core/src/component/sessions.ts", blob, kind: "translated" }]), pinnedCommit: pin }), []);
});

test("entries must exist, match their header and be well formed", (t) => {
  const root = workspace(t, {
    "auth/a.ts": derived("packages/core/src/component/a.ts"),
    "auth/b.ts": "export {};\n",
    "auth/c.ts": derived("packages/core/src/component/c.ts", "1".repeat(40)),
  });
  const problems = checkAuthProvenance({
    sourceRoot: root,
    record: record([
      { path: "auth/a.ts", upstream: "packages/core/src/component/other.ts", blob, kind: "translated" },
      { path: "auth/b.ts", upstream: "packages/core/src/component/b.ts", blob: "short", kind: "renamed" },
      { path: "auth/c.ts", upstream: "packages/core/src/component/c.ts", blob, kind: "copied" },
      { path: "auth/gone.ts", upstream: "packages/core/src/component/gone.ts", blob, kind: "copied" },
    ]),
    pinnedCommit: pin,
  });
  assert.deepEqual(problems, [
    'file "auth/a.ts" header names packages/core/src/component/a.ts, its entry packages/core/src/component/other.ts',
    'file "auth/b.ts" needs a 40-hex git blob',
    'file "auth/b.ts" kind must be "translated" or "copied"',
    'file "auth/b.ts" is recorded but does not start with the provenance header',
    `file "auth/c.ts": header line 2 must name the pinned commit: // at ${pin}. Copyright 2026 Convex, Inc.`,
    'file "auth/gone.ts" is recorded but does not exist',
  ]);
});

test("the record's commit must be the convex-auth pin", (t) => {
  const root = workspace(t, {});
  assert.match(checkAuthProvenance({ sourceRoot: root, record: { ...record([]), commit: "1".repeat(40) }, pinnedCommit: pin })[0], /differs from the convex-auth pin/);
});

test("omitted patterns cover directories and globs", () => {
  assert.ok(matchesOmitted("packages/core/src/react", "packages/core/src/react/client.tsx"));
  assert.ok(matchesOmitted("packages/core/src/methods/*/react*", "packages/core/src/methods/username-passkey/react_impl.tsx"));
  assert.ok(matchesOmitted("packages/core/src/**/_generated", "packages/core/src/components/email/_generated/api.ts"));
  assert.ok(matchesOmitted("packages/core/src/**/convex.config.ts", "packages/core/src/component/convex.config.ts"));
  assert.ok(!matchesOmitted("packages/core/src/methods/*/react*", "packages/core/src/methods/oauth/server.ts"));
  assert.ok(!matchesOmitted("packages/core/src/react", "packages/core/src/reactive.ts"));
});
