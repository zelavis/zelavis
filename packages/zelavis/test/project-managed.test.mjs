import assert from "node:assert/strict";
import test from "node:test";

import { normalizeProjectManaged } from "../dist/project-managed.js";
import { loadService } from "../dist/service.js";

test("a recipe's managed declaration is validated, and absence means Zelavis-native", () => {
  assert.equal(normalizeProjectManaged(undefined), undefined);
  assert.deepEqual({ ...normalizeProjectManaged({}) }, {});
  assert.deepEqual(
    { ...normalizeProjectManaged({ adminTitle: "WordPress Admin", adminPath: "/wp-admin/" }) },
    { adminTitle: "WordPress Admin", adminPath: "/wp-admin/" },
  );
  for (const bad of [
    null, [], "wp", { other: 1 }, { adminTitle: "" }, { adminTitle: "a\nb" },
    { adminPath: "https://evil.example/" }, { adminPath: "//evil.example" }, { adminPath: "wp-admin" },
    { adminPath: "/a/../b" }, { adminPath: "/a b" }, { adminPath: "/x?y=1" },
  ]) {
    assert.throws(() => normalizeProjectManaged(bad), undefined, JSON.stringify(bad));
  }
});

test("a package that declares invalid managed metadata is refused when it loads", async () => {
  const manifest = (managed) => ({
    name: "@acme/blog", version: "1.0.0", type: "module", exports: { ".": "./index.js" },
    zelavis: { kind: "app", namespace: "blog", project: { runtimeKinds: ["native"], managed } },
  });
  await assert.rejects(
    loadService("@acme/blog", { manifest: manifest({ adminPath: "https://evil.example/" }), importer: async () => ({}) }),
    /invalid zelavis\.project\.managed/,
  );
  const service = await loadService("@acme/blog", {
    manifest: manifest({ adminTitle: "Blog Admin", adminPath: "/admin/" }), importer: async () => ({}),
  });
  assert.deepEqual({ ...service.project.managed }, { adminTitle: "Blog Admin", adminPath: "/admin/" });
});
