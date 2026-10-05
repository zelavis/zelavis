import assert from "node:assert/strict";
import test from "node:test";
import { assertReleaseAllowlist } from "../release-allowlist.mjs";

const manifest = { name: "@zelavis/wordpress", version: "7.1.3-alpha.2" };
const current = { name: manifest.name, latest: manifest.version, versions: [{ version: manifest.version }] };

test("release refuses a stale default even when the new recipe is listed", () => {
  assert.throws(() => assertReleaseAllowlist({ services: [{ ...current, latest: "7.1.3-alpha.1" }] }, [manifest]), /Publish changed services first/);
});

test("release refuses a default without an exact listed version", () => {
  assert.throws(() => assertReleaseAllowlist({ services: [{ ...current, versions: [] }] }, [manifest]), /shipped allow-list default/);
  assert.throws(() => assertReleaseAllowlist({ services: [] }, [manifest]), /shipped allow-list default/);
});

test("release accepts qualified defaults while retaining other exact versions", () => {
  assert.doesNotThrow(() => assertReleaseAllowlist({ services: [{ ...current, versions: [{ version: "7.1.3-alpha.1" }, ...current.versions] }] }, [manifest]));
});


test("release refuses lost managed recipe metadata even when its version matches", () => {
  const managed = { adminTitle: "WordPress Admin", adminPath: "/wp-admin/" };
  const recipe = { ...manifest, zelavis: { project: { managed } } };
  assert.throws(() => assertReleaseAllowlist({ services: [current] }, [recipe]), /stale managed metadata/);
  assert.doesNotThrow(() => assertReleaseAllowlist({ services: [{ ...current, managed: { adminPath: managed.adminPath, adminTitle: managed.adminTitle } }] }, [recipe]));
});
