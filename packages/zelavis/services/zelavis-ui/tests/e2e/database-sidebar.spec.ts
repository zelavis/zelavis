import { expect, test, type Route } from "@playwright/test";

const basePath = (process.env.ZELAVIS_UI_BASE_PATH ?? "/").replace(/\/+$/, "");
const projectId = process.env.ZELAVIS_E2E_PROJECT_ID;

async function transformResponse(route: Route, transform: (body: any) => void) {
  try {
    const response = await route.fetch(), body = await response.json();
    transform(body);
    await route.fulfill({ response, json: body });
  } catch (error) {
    // Reload/navigation can dispose an in-flight intercepted response.
    if (!(error instanceof Error) || !/disposed|closed|aborted|cancelled/i.test(error.message)) throw error;
    await route.continue().catch(() => undefined);
  }
}

for (const managed of [false, true]) test(`@smoke @embedded ${managed ? "managed" : "native"} backend table creation persists in the sidebar`, async ({ page }, testInfo) => {
  test.skip(!projectId, "needs the e2e Project");
  if (managed) {
    // Only the recipe classification is changed. All database writes, menu
    // discovery, reads and reloads use the actual isolated Project runtime.
    await page.route(/\/runtime\/projects$/, async route => {
      if (route.request().method() !== "GET") return route.continue();
      await transformResponse(route, body => {
        body.projects = body.projects.map((project: { id: string; recipe: object }) => project.id === projectId
          ? { ...project, recipe: { ...project.recipe, managed: { adminTitle: "WordPress Admin", adminPath: "/wp-admin/" } } } : project);
      });
    });
    await page.route(new RegExp(`/projects/${projectId}/proxy/zelavis/api/v1/runtime/config$`), async route => {
      await transformResponse(route, body => {
        body.capabilities.database = { ...body.capabilities.database, used: true };
      });
    });
  }
  const name = `sidebar_${managed ? "managed" : "native"}_${testInfo.project.name}`;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${basePath}/projects/${projectId}/database/new`);
  await page.getByLabel("Table name").fill(name);
  await page.getByRole("button", { name: "Create and Open Table" }).click();
  await expect(page).toHaveURL(new RegExp(`databaseTable=${name}`));
  const mobile = testInfo.project.name === "mobile";
  const sidebar = mobile ? page.getByRole("dialog", { name: "Dashboard", exact: true })
    : page.getByRole("navigation", { name: "Dashboard navigation" });
  async function showDatabaseMenu() {
    if (mobile) await sidebar.getByRole("button", { name: "Database", exact: true }).click();
  }
  await showDatabaseMenu();
  const active = sidebar.locator(".swiper-slide-active").first();
  await expect(active.getByRole("link", { name: new RegExp(`${name}$`) })).toBeVisible();
  await page.reload();
  await showDatabaseMenu();
  await expect(active.getByRole("link", { name: new RegExp(`${name}$`) })).toBeVisible();
  const link = active.getByRole("link", { name: new RegExp(`${name}$`) });
  await expect(link).toHaveAttribute("href", /databaseTenant=zelavis-app/);
  await page.goto(`${basePath}/projects/${projectId}/backend`);
  await page.goto(`${basePath}/projects/${projectId}/database`);
  await showDatabaseMenu();
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(new RegExp(`databaseTable=${name}`));
  await showDatabaseMenu();
  const systemTables = active.getByRole("button", { name: "System Tables", exact: true });
  await expect(systemTables).toBeVisible();
  await systemTables.click();
  await expect(active.getByRole("link", { name: "Events", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("@smoke @embedded Platform backend tables are navigable and remain separate from Project tables", async ({ page }) => {
  const response = await page.request.get(`${basePath}/api/v1/runtime/system-store/namespaces`);
  expect(response.status(), await response.text()).toBe(200);
  await page.goto(`${basePath}/server/database`);
  const tables = page.getByRole("table", { name: "Platform backend tables" });
  await expect(tables).toBeVisible();
  await expect(tables.getByRole("link", { name: "zelavis.platform.auth", exact: true })).toBeVisible();
  await tables.getByRole("link", { name: "platform", exact: true }).click();
  await expect(page).toHaveURL(/\/server\/database\?namespace=platform/);
  const records = page.getByRole("table", { name: "platform records" });
  await expect(records).toContainText("[redacted]");
  await page.reload();
  await expect(records).toBeVisible();
  await expect(page.getByRole("button", { name: "Create and Open Table" })).toHaveCount(0);
  await expect(records).not.toContainText("sidebar_native");
});
