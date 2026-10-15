import { describe, expect, it, vi, afterEach } from "vitest";

import { resolveReturnTo, stripRouterBasename } from "#/lib/router-basename";

function withBase(base: string) {
  vi.stubEnv("BASE_URL", base);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("stripRouterBasename", () => {
  it("makes a mounted path router-relative", () => {
    withBase("/zelavis/");
    expect(stripRouterBasename("/zelavis/")).toBe("/");
    expect(stripRouterBasename("/zelavis/database")).toBe("/database");
  });

  it("collapses paths that already accumulated the basename", () => {
    withBase("/zelavis/");
    expect(stripRouterBasename("/zelavis/zelavis/")).toBe("/");
    expect(
      stripRouterBasename("/zelavis/zelavis/zelavis/zelavis/zelavis/zelavis/"),
    ).toBe("/");
    expect(stripRouterBasename("/zelavis/zelavis/settings")).toBe("/settings");
  });

  it("leaves unrelated paths alone", () => {
    withBase("/zelavis/");
    expect(stripRouterBasename("/database")).toBe("/database");
    // A route that merely starts with the same characters is not the basename.
    expect(stripRouterBasename("/zelavisation")).toBe("/zelavisation");
  });

  it("is a no-op when the dashboard is not mounted under a base path", () => {
    withBase("/");
    expect(stripRouterBasename("/database")).toBe("/database");
    expect(stripRouterBasename("/")).toBe("/");
  });
});

describe("resolveReturnTo", () => {
  it("normalizes a mounted returnTo", () => {
    withBase("/zelavis/");
    expect(resolveReturnTo("/zelavis/database")).toBe("/database");
    expect(resolveReturnTo("/zelavis/zelavis/zelavis/")).toBe("/");
  });

  it("falls back to the dashboard root for missing or relative values", () => {
    withBase("/zelavis/");
    expect(resolveReturnTo(null)).toBe("/");
    expect(resolveReturnTo("")).toBe("/");
    expect(resolveReturnTo("database")).toBe("/");
  });

  it("rejects protocol-relative and absolute destinations", () => {
    withBase("/zelavis/");
    expect(resolveReturnTo("//evil.example/pwn")).toBe("/");
    expect(resolveReturnTo("https://evil.example/pwn")).toBe("/");
  });
});
