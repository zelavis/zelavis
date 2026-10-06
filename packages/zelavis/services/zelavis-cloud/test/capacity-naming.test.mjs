import assert from "node:assert/strict";
import test from "node:test";
import { capacityIdentity, capacityLabels, capacityNodeName } from "../dist/index.js";

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

test("the machine name is a pure function of the request id", () => {
  assert.equal(capacityNodeName("req-1"), capacityNodeName("req-1"));
  assert.notEqual(capacityNodeName("req-1"), capacityNodeName("req-2"));
});

test("names are valid hostnames within the 63 character limit", () => {
  for (const id of ["req-1", "Req_With Spaces/And*Symbols", "ü".repeat(200), "a".repeat(500), "---", "1"]) {
    const name = capacityNodeName(id);
    assert.match(name, HOSTNAME, id);
    assert.ok(name.length <= 63, `${id.slice(0, 20)} -> ${name.length}`);
    assert.ok(name.startsWith("zelavis-"));
  }
});

test("ids that normalize to the same readable part still get different names", () => {
  assert.notEqual(capacityNodeName("a b"), capacityNodeName("a-b"));
  assert.notEqual(capacityNodeName("A_B"), capacityNodeName("a.b"));
  assert.notEqual(capacityNodeName("x".repeat(200) + "1"), capacityNodeName("x".repeat(200) + "2"));
});

test("labels identify the platform and request without carrying raw ids", () => {
  const labels = capacityLabels({ requestId: "req-1", platformId: "platform-1" });
  assert.equal(labels["zelavis.io/managed"], "true");
  for (const value of Object.values(labels)) assert.match(value, /^[a-z0-9]+$/);
  assert.ok(!JSON.stringify(labels).includes("req-1"));
  assert.notDeepEqual(labels, capacityLabels({ requestId: "req-2", platformId: "platform-1" }));
  assert.notDeepEqual(labels, capacityLabels({ requestId: "req-1", platformId: "platform-2" }));
});

test("identity bundles the name and labels", () => {
  const identity = capacityIdentity({ requestId: "req-1", platformId: "platform-1" });
  assert.equal(identity.name, capacityNodeName("req-1"));
  assert.deepEqual(identity.labels, capacityLabels({ requestId: "req-1", platformId: "platform-1" }));
});

test("empty identifiers are refused", () => {
  assert.throws(() => capacityNodeName(""), TypeError);
  assert.throws(() => capacityNodeName("   "), TypeError);
  assert.throws(() => capacityLabels({ requestId: "r", platformId: "" }), TypeError);
});
