import { defineConfig, devices } from "@playwright/test";

// The first-run wizard needs a Platform nobody has claimed yet, so it cannot
// share the dashboard e2e config, whose global setup bootstraps the owner first.
const uiPort = process.env.ZELAVIS_E2E_UI_PORT ?? "3100";
const origin = `http://127.0.0.1:${uiPort}`;

export default defineConfig({
  testDir: "./tests/setup-e2e",
  outputDir: "./test-results/setup",
  reporter: "list",
  workers: 1,
  fullyParallel: false,
  use: { baseURL: origin, trace: "on-first-retry" },
  webServer: {
    command: `pnpm exec react-router dev --host 127.0.0.1 --port ${uiPort}`,
    reuseExistingServer: !process.env.CI,
    url: `${origin}/`,
  },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }],
});
