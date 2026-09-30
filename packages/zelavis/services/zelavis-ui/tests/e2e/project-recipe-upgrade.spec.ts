import { expect, test, type Page } from "@playwright/test"

const basePath = (process.env.ZELAVIS_UI_BASE_PATH ?? "/").replace(/\/+$/, "")
const projectId = process.env.ZELAVIS_E2E_PROJECT_ID

/**
 * Makes the e2e Project look like one whose recipe the Platform has moved past.
 * The real list is fetched and patched, so everything else on the card is real.
 */
async function pretendStale(page: Page, patch: Record<string, unknown>) {
  await page.route(/\/runtime\/projects$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue()
    const response = await route.fetch()
    const body = await response.json()
    body.projects = body.projects.map((project: { id: string }) =>
      project.id === projectId ? { ...project, ...patch } : project,
    )
    await route.fulfill({ response, json: body })
  })
}

test("@smoke a stopped Project on an older recipe can be upgraded from its card", async ({ page }) => {
  test.skip(!projectId, "needs the e2e Project")
  await pretendStale(page, {
    recipeStatus: { state: "upgradeAvailable", version: "9.9.9" },
    runtime: { driver: "node-process", status: "failed", error: "Project recipe x cannot be prepared" },
  })
  let posted: unknown
  await page.route(new RegExp(`/runtime/projects/${projectId}/upgrade$`), async (route) => {
    posted = route.request().postDataJSON()
    await route.fulfill({
      json: { project: { id: projectId, name: "Zelavis Runtime", recipe: { name: "@zelavis/app", title: "App", version: "9.9.9" },
        runtime: { driver: "node-process", status: "stopped" }, runtimeKind: "native", kind: "zelavis", capabilities: {},
        desiredState: "stopped", createdAt: "", updatedAt: "" } },
    })
  })

  await page.goto(`${basePath}/projects`)
  const notice = page.getByLabel("Recipe upgrade")
  await expect(notice).toContainText("A newer recipe is available: 9.9.9")
  await expect(notice).toContainText("keeps this Project's data")
  await notice.getByRole("button", { name: "Upgrade recipe" }).click()
  await expect(page.getByText(/now uses @zelavis\/app 9\.9\.9\. Its data is unchanged/)).toBeVisible()
  expect(posted).toEqual({})
})

test("@smoke a Project on a retired recipe must be pointed at one, and a running one must be stopped first", async ({ page }) => {
  test.skip(!projectId, "needs the e2e Project")
  await pretendStale(page, {
    recipeStatus: { state: "unavailable", reason: 'This Platform ships no recipe named "zelavis/app".' },
    runtime: { driver: "node-process", status: "running", url: "http://127.0.0.1:1" },
  })
  await page.goto(`${basePath}/projects`)
  const notice = page.getByLabel("Recipe upgrade")
  await expect(notice).toContainText('ships no recipe named "zelavis/app"')
  await expect(notice.getByRole("button", { name: "Upgrade recipe" })).toBeDisabled()
  await expect(notice).toContainText("Stop the Project first.")
})
