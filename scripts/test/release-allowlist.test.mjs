import assert from "node:assert/strict";
import test from "node:test";
import { assertReleaseAllowlist, minimumPlatform } from "../release-allowlist.mjs";

const manifest = { name: "@zelavis/wordpress", version: "7.1.3-alpha.2", peerDependencies: { zelavis: ">=2.0.0-alpha.36" } };
const current = { name: manifest.name, latest: manifest.version, versions: [{ version: manifest.version, platform: "2.0.0-alpha.36" }] };

test("release refuses a stale default even when the new recipe is listed", () => {
  assert.throws(() => assertReleaseAllowlist({ services: [{ ...current, latest: "7.1.3-alpha.1" }] }, [manifest]), /is not the shipped allow-list default/);
});

test("release refuses a default without an exact listed version", () => {
  assert.throws(() => assertReleaseAllowlist({ services: [{ ...current, versions: [] }] }, [manifest]), /shipped allow-list default/);
  assert.throws(() => assertReleaseAllowlist({ services: [] }, [manifest]), /shipped allow-list default/);
});

test("release accepts qualified defaults while retaining other exact versions", () => {
  assert.doesNotThrow(() => assertReleaseAllowlist({ services: [{ ...current, versions: [{ version: "7.1.3-alpha.1", platform: "2.0.0-alpha.30" }, ...current.versions] }] }, [manifest]));
});


test("release refuses lost managed recipe metadata even when its version matches", () => {
  const managed = { adminTitle: "WordPress Admin", adminPath: "/wp-admin/" };
  const recipe = { ...manifest, zelavis: { project: { managed } } };
  assert.throws(() => assertReleaseAllowlist({ services: [current] }, [recipe]), /stale managed metadata/);
  assert.doesNotThrow(() => assertReleaseAllowlist({ services: [{ ...current, managed: { adminPath: managed.adminPath, adminTitle: managed.adminTitle } }] }, [recipe]));
});

test("the minimum is read from a >= range only", () => {
  assert.equal(minimumPlatform(">=2.0.0-alpha.36", "x"), "2.0.0-alpha.36");
  assert.equal(minimumPlatform(">= 2.1.0", "x"), "2.1.0");
  for (const range of [undefined, ">=2", "^2.0.0", ">=2.0.0-alpha.36 <3", "*", "workspace:*"])
    assert.throws(() => minimumPlatform(range, "x"), /peerDependencies\.zelavis/);
});
