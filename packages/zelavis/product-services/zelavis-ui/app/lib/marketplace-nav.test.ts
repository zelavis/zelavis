import { describe, expect, it } from "vitest";

import { zelavis } from "zelavis";

import {
  buildPlatformNavItems,
  buildProjectManagementNavItems,
  findServiceMenuContentByPath,
} from "./dashboard-data";

/**
 * The dashboard no longer names the marketplace anywhere. These assert that it
 * still reaches the nav, using the real runtime config rather than a fixture —
 * a fixture would only prove the fixture was written correctly.
 */
async function runtimeConfig() {
  const runtime = await zelavis({});
  const response = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/config"),
  );
  return response.json();
}

describe("the marketplace reaches the dashboard through the service registry", () => {
  it("appears on the platform slide", async () => {
    const config = await runtimeConfig();
    const items = buildProjectManagementNavItems(config.services);

    const marketplace = items.find((item) => item.title === "Marketplace");
    expect(marketplace).toBeDefined();
    expect(marketplace?.url).toBe("/marketplace");
    expect(marketplace?.sectionLabel).toBe("Explore");
  });

  it("appears on a project's root slide", async () => {
    const config = await runtimeConfig();
    const items = buildPlatformNavItems(
      config.services,
      config.serviceRegistry,
      undefined,
      undefined,
      "project-a",
    );

    const marketplace = items.find((item) => item.title === "Marketplace");
    expect(marketplace).toBeDefined();
    expect(marketplace?.url).toBe("/projects/project-a/marketplace");
  });

  it("resolves to a frame, not a placeholder", async () => {
    const config = await runtimeConfig();
    const content = findServiceMenuContentByPath(
      "/marketplace",
      config.services,
      config.serviceRegistry,
    );

    expect(content?.kind).toBe("frame");
    expect(content?.kind === "frame" && content.page.src).toMatch(
      /service-page-assets\/%40zelavis%2Fmarketplace\//,
    );
  });
});
