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
const uiPort = process.env.ZELAVIS_E2E_UI_PORT ?? "3100";
const webServerOrigin = `http://127.0.0.1:${uiPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results",
  reporter: "list",
  // One runtime is shared by every spec and some of them change it (the
  // Assistant provider setting decides how the chat answers), so specs run one
  // at a time rather than racing over that state.
  workers: 1,
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: webServerOrigin,
    trace: "on-first-retry",
    // The dashboard needs a real Platform session to hydrate; global setup
    // bootstraps or signs in the first owner and stores its session cookie.
    storageState: storageStatePath,
  },
  webServer: {
    command: `pnpm exec react-router dev --host 127.0.0.1 --port ${uiPort}`,
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
