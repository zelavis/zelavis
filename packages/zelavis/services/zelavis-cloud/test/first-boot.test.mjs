import assert from "node:assert/strict";
import test from "node:test";
import { workerFirstBoot, workerFirstBootScript } from "../dist/index.js";

const good = {
  platformUrl: "https://panel.example.com/zelavis",
  platformFingerprint: `sha256:${"ab".repeat(32)}`,
  nodeId: "zelavis-abc123",
  enrollmentToken: "tok_0123456789abcdefghij",
};

test("the script runs the real installer role and join with a pinned fingerprint", () => {
  const script = workerFirstBootScript(good);
  assert.match(script, /^#!\/bin\/sh\nset -eu\n/);
  assert.match(script, /--role worker/);
  assert.match(script, /worker join --data-dir '\/var\/lib\/zelavis-worker'/);
  assert.match(script, new RegExp(`--platform-fingerprint 'sha256:${"ab".repeat(32)}'`));
  assert.match(script, /--node-id 'zelavis-abc123' --enrollment-token 'tok_0123456789abcdefghij'/);
  assert.match(script, /runuser -u zelavis-worker --/);
});

test("a colon-separated, upper-case fingerprint is normalized", () => {
  const colons = "AB".repeat(32).match(/../g).join(":");
  assert.match(workerFirstBootScript({ ...good, platformFingerprint: colons }), new RegExp(`sha256:${"ab".repeat(32)}'`));
});

test("no value can add a shell command", () => {
  for (const bad of [
    { platformUrl: "https://x.example/'; rm -rf / #" },
    { platformUrl: "http://panel.example.com" },
    { platformUrl: "https://user:pw@panel.example.com" },
    { platformUrl: "https://panel.example.com/?a=1" },
    { platformFingerprint: "sha256:xyz" },
    { nodeId: "a'; reboot; '" },
    { nodeId: "" },
    { enrollmentToken: "short" },
    { enrollmentToken: `${"a".repeat(20)}'; id; '` },
    { installerUrl: "http://zelavis.com/install.sh" },
  ]) {
    assert.throws(() => workerFirstBootScript({ ...good, ...bad }), (e) => e.code === "invalid-request" || e.name === "CapacityError", JSON.stringify(bad));
  }
});

test("the capacity provider hook mints one token per machine", async () => {
  const minted = [];
  const hook = workerFirstBoot({
    platformUrl: good.platformUrl,
    platformFingerprint: good.platformFingerprint,
    mintEnrollmentToken: (nodeId) => { minted.push(nodeId); return `tok_${nodeId.padEnd(20, "x")}`; },
  });
  const script = await hook({ nodeId: "zelavis-node1" });
  assert.deepEqual(minted, ["zelavis-node1"]);
  assert.match(script, /--node-id 'zelavis-node1'/);
  assert.doesNotMatch(script, /hetzner|HCLOUD|API_TOKEN/i);
});
