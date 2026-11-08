import assert from "node:assert/strict";
import test from "node:test";
import { proposeBoundedLoadNode } from "../dist/core/fabric/bounded-load.js";

/** Places `count` keys one after another on the given Nodes, each placement counted into the loads the next one sees. */
const place = (nodes, count, prefix = "key") => {
  const loads = new Map(nodes.map((node) => [node.id, 0]));
  const placed = [];
  for (let at = 0; at < count; at += 1) {
    const id = proposeBoundedLoadNode(`${prefix}-${at}`, nodes.map((node) => ({ ...node, load: loads.get(node.id) })));
    loads.set(id, loads.get(id) + 1);
    placed.push(id);
  }
  return { loads, placed };
};
const equal = (count) => Array.from({ length: count }, (_, at) => ({ id: `node-${String.fromCharCode(97 + at)}`, weight: 1, load: 0 }));

test("the same input gives the same Node, whatever order the Nodes are given in", () => {
  const nodes = equal(4);
  for (let at = 0; at < 50; at += 1) {
    const first = proposeBoundedLoadNode(`shard-${at}`, nodes);
    assert.equal(proposeBoundedLoadNode(`shard-${at}`, nodes), first);
    assert.equal(proposeBoundedLoadNode(`shard-${at}`, [...nodes].reverse()), first);
  }
});

test("placements spread over equal Nodes and no Node passes its cap", () => {
  const { loads } = place(equal(4), 400);
  console.log(`spread of 400 over 4: ${[...loads.values()].join(", ")}`);
  for (const [id, load] of loads) assert.ok(load <= 125 && load >= 50, `${id} holds ${load}`);
});

test("a heavier Node takes a larger share", () => {
  const { loads } = place([{ id: "heavy", weight: 4, load: 0 }, { id: "light", weight: 1, load: 0 }], 500);
  console.log(`weights 4:1 over 500: ${[...loads].map(([id, load]) => `${id} ${load}`).join(", ")}`);
  assert.ok(loads.get("heavy") > 300, `heavy holds ${loads.get("heavy")}`);
  assert.ok(loads.get("heavy") <= Math.ceil(1.25 * 500 * 4 / 5));
});

test("adding a Node moves only part of the placements", () => {
  const keys = Array.from({ length: 1000 }, (_, at) => `key-${at}`);
  const four = equal(4);
  const five = equal(5);
  const before = keys.map((key) => proposeBoundedLoadNode(key, four));
  const after = keys.map((key) => proposeBoundedLoadNode(key, five));
  const moved = before.filter((id, at) => id !== after[at]).length;
  console.log(`moved when a fifth Node joined: ${moved} of 1000`);
  assert.ok(moved <= 350, `${moved} moved`);
});

test("no Nodes propose nothing, and a duplicate or malformed Node is refused", () => {
  assert.equal(proposeBoundedLoadNode("key", []), undefined);
  assert.throws(() => proposeBoundedLoadNode("key", [{ id: "a", weight: 1, load: 0 }, { id: "a", weight: 1, load: 0 }]), TypeError);
  assert.throws(() => proposeBoundedLoadNode("key", [{ id: "a", weight: 1, load: -1 }]), TypeError);
  assert.throws(() => proposeBoundedLoadNode("key", [{ id: "a", weight: Number.NaN, load: 0 }]), TypeError);
  assert.equal(proposeBoundedLoadNode("key", [{ id: "only", weight: 1, load: 99 }]), "only", "a lone Node is always chosen");
});
