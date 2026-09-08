import { defineConfig, devices } from "@playwright/test";

import { storageStatePath } from "./tests/e2e/global-setup";

function normalizeBasePath(path: string) {
  if (!path || path === "/") {
    return "/";
  }

  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  return `${withLeadingSlash.replace(/\/+$/, "")}/`;
}

const dashboardBasePath = normalizeBasePath(
  process.env.ZELAVIS_UI_BASE_PATH ?? "/",
);
const webServerOrigin = "http://127.0.0.1:3100";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results",
  reporter: "list",
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: webServerOrigin,
    trace: "on-first-retry",
    // The dashboard needs a real Platform session to hydrate; global setup
    // bootstraps or signs in the first owner and stores its session cookie.
    storageState: storageStatePath,
  },
  webServer: {
    command: "pnpm exec react-router dev --host 127.0.0.1 --port 3100",
    reuseExistingServer: !process.env.CI,
    url: `${webServerOrigin}${dashboardBasePath === "/" ? "/" : dashboardBasePath}`,
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: {
          width: 1280,
          height: 900,
        },
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["Pixel 7"],
      },
    },
  ],
});
