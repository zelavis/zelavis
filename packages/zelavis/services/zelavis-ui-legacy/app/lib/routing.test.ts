import { describe, expect, it } from "vitest";

import {
  isProjectRootPath,
  toProjectPath,
} from "./routing";

describe("dashboard routing helpers", () => {
  it("recognizes canonical project overview routes", () => {
    expect(isProjectRootPath("/projects/project-a")).toBe(true);
    expect(isProjectRootPath("/projects/project-a/")).toBe(true);
    expect(isProjectRootPath("/projects/project-a/extensions")).toBe(false);
    expect(isProjectRootPath("/projects")).toBe(false);
  });

  it("builds project overview paths without search state", () => {
    expect(toProjectPath("/", "project-a")).toBe("/projects/project-a");
  });
});
