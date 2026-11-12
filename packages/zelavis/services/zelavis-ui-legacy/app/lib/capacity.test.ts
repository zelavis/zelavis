import { describe, expect, it } from "vitest";

import { isValidNodeId, joinCommand, newRequestId } from "./capacity";

describe("capacity helpers", () => {
  it("accepts the node ids the Platform accepts and no others", () => {
    for (const ok of ["a", "worker-1", "w9"]) expect(isValidNodeId(ok)).toBe(true);
    for (const bad of ["", "-a", "a-", "Worker", "a_b", "a".repeat(64), "a b"]) expect(isValidNodeId(bad)).toBe(false);
  });

  it("builds a join command that pins the Platform certificate", () => {
    const command = joinCommand({
      platform: { url: "https://panel.example.com/", fingerprint: "ab".repeat(32) },
      nodeId: "worker-1",
      token: "tok",
    });
    expect(command).toBe(
      `zelavis worker join --platform-url https://panel.example.com/zelavis --node-id worker-1 --enrollment-token tok --platform-fingerprint sha256:${"ab".repeat(32)}`,
    );
  });

  it("keeps an existing sha256: prefix", () => {
    const command = joinCommand({
      platform: { url: "https://h", fingerprint: `sha256:${"cd".repeat(32)}` },
      nodeId: "n",
      token: "t",
    });
    expect(command).toContain(`--platform-fingerprint sha256:${"cd".repeat(32)}`);
    expect(command).not.toContain("sha256:sha256:");
  });

  it("makes request ids the controller accepts, and different each time", () => {
    const a = newRequestId();
    expect(a).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    expect(newRequestId()).not.toBe(a);
  });
});

describe("scale-out wording", () => {
  it("says something for every outcome the Platform reports, and passes unknown ones through", async () => {
    const { describeScaleOutOutcome } = await import("./capacity");
    for (const outcome of [undefined, "requested", "waiting", "booting", "at-limit", "cooling-down", "no-consent", "no-provider", "failed"]) {
      expect(describeScaleOutOutcome(outcome).length).toBeGreaterThan(10);
    }
    expect(describeScaleOutOutcome("something-new")).toBe("something-new");
  });
});
