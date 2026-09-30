import { defineConfig, devices } from "@playwright/test";

// The first-run wizard needs a Platform nobody has claimed yet, so it cannot
// share the dashboard e2e config, whose global setup bootstraps the owner first.
const origin = "http://127.0.0.1:3100";

export default defineConfig({
  testDir: "./tests/setup-e2e",
  outputDir: "./test-results/setup",
  reporter: "list",
  workers: 1,
  fullyParallel: false,
  use: { baseURL: origin, trace: "on-first-retry" },
  webServer: {
    command: "pnpm exec react-router dev --host 127.0.0.1 --port 3100",
    reuseExistingServer: !process.env.CI,
    url: `${origin}/`,
  },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }],
});
