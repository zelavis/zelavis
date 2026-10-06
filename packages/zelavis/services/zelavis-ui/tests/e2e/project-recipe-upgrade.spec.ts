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
    // A navigation can cancel this request while it is being fetched, which
    // disposes the response. That is not a failure of what is under test, so the
    // request is simply let through (or already gone).
    try {
      const response = await route.fetch()
      const body = await response.json()
      body.projects = body.projects.map((project: { id: string }) =>
        project.id === projectId ? { ...project, ...patch } : project,
      )
      await route.fulfill({ response, json: body })
    } catch {
      await route.continue().catch(() => undefined)
    }
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
    capabilities: { zeroDowntimeUpdates: false },
  })
  await page.goto(`${basePath}/projects`)
  const notice = page.getByLabel("Recipe upgrade")
  await expect(notice).toContainText('ships no recipe named "zelavis/app"')
  await expect(notice.getByRole("button", { name: "Upgrade recipe" })).toBeDisabled()
  await expect(notice).toContainText("Stop the Project first.")
})

test("@smoke a qualified running App can upgrade at the same address", async ({ page }) => {
  test.skip(!projectId, "needs the e2e Project")
  await pretendStale(page, {
    recipeStatus: { state: "upgradeAvailable", version: "9.9.9" },
    runtime: { driver: "node-process", status: "running", url: "http://127.0.0.1:1" },
    capabilities: { zeroDowntimeUpdates: true },
  })
  await page.route(new RegExp(`/runtime/projects/${projectId}/upgrade$`), async route => {
    await route.fulfill({ json: { project: { id: projectId, name: "Zelavis Runtime", recipe: { name: "@zelavis/app", version: "9.9.9" },
      runtime: { status: "running", url: "http://127.0.0.1:1" } } } })
  })
  await page.goto(`${basePath}/projects`)
  const notice = page.getByLabel("Recipe upgrade")
  await expect(notice.getByRole("button", { name: "Upgrade recipe" })).toBeEnabled()
  await expect(notice).not.toContainText("Stop the Project first.")
  await notice.getByRole("button", { name: "Upgrade recipe" }).click()
  await expect(page.getByText(/It is running at the same address/)).toBeVisible()
})

test("@smoke a Project that is not running cannot be opened from its card, and its pages explain themselves", async ({ page }) => {
  test.skip(!projectId, "needs the e2e Project")
  await pretendStale(page, { runtime: { driver: "node-process", status: "stopped" } })

  await page.goto(`${basePath}/projects`)
  await expect(page.getByRole("button", { name: "Open" }).first()).toBeDisabled()

  // Reached anyway (a link, a reload): an explanation, not "Dashboard error".
  await page.goto(`${basePath}/projects/${projectId}`)
  await expect(page.getByText("This Project is not running")).toBeVisible()
  await expect(page.getByText("Dashboard error")).toHaveCount(0)
  await page.getByRole("button", { name: "Back to Projects" }).click()
  await expect(page).toHaveURL(/\/projects$/)
})

test("@smoke a failed deletion refreshes its card and offers only deletion recovery", async ({page}) => {
  test.skip(!projectId,"needs the e2e Project")
  let pendingDeletion = false
  let removed = false
  let deletes = 0
  let forbiddenActions = 0
  const deletion = {status:"failed",startedAt:"2026-10-03T12:00:00Z",updatedAt:"2026-10-03T12:00:00Z",participants:["runtime-stop"],completedParticipants:[],currentParticipant:"runtime-stop",error:"Descriptor was never written"}
  await page.route(/\/runtime\/projects$/,async route=>{
    if(route.request().method()!=="GET") return route.continue()
    const response=await route.fetch()
    const body=await response.json()
    body.projects=body.projects.filter((p:{id:string})=>!(removed&&p.id===projectId)).map((p:{id:string})=>p.id===projectId?{...p,recipeStatus:{state:"upgradeAvailable",version:"9.9.9"},runtime:{driver:"node-process",status:"failed"},...(pendingDeletion?{deletion}:{})}:p)
    await route.fulfill({response,json:body})
  })
  await page.route(new RegExp(`/runtime/projects/${projectId}$`),async route=>{
    if(route.request().method()!=="DELETE") return route.continue()
    deletes++
    pendingDeletion=true
    if(deletes===1) await route.fulfill({status:500,json:{error:"Deletion failed during runtime-stop"}})
    else {removed=true;await route.fulfill({json:{deleted:true}})}
  })
  await page.route(new RegExp(`/runtime/projects/${projectId}/(start|restart|upgrade)$`),async route=>{
    forbiddenActions++
    await route.fulfill({status:409,json:{error:"pending deletion"}})
  })
  page.on("dialog",dialog=>dialog.accept())
  await page.goto(`${basePath}/projects`)
  await expect(page.getByLabel("Recipe upgrade")).toBeVisible()
  await page.getByRole("button",{name:"Delete",exact:true}).first().click()
  const notice=page.getByLabel("Project deletion")
  await expect(notice).toContainText("Deletion failed")
  await expect(notice).toContainText("Descriptor was never written")
  await expect(page.getByLabel("Recipe upgrade")).toHaveCount(0)
  await expect(page.getByRole("button",{name:"Start",exact:true}).first()).toBeDisabled()
  await expect(page.getByRole("button",{name:"Restart",exact:true}).first()).toBeDisabled()
  await expect(page.getByRole("button",{name:"Open",exact:true}).first()).toBeDisabled()
  await page.getByRole("button",{name:"Retry deletion",exact:true}).click()
  await expect(notice).toHaveCount(0)
  expect(deletes).toBe(2)
  expect(forbiddenActions).toBe(0)
})

test("@smoke App engine selection survives reload and sends the exact version", async ({ page }) => {
  test.skip(!projectId, "needs the e2e Project")
  await pretendStale(page, { engineVersion: "2.0.0-alpha.18", capabilities: { zeroDowntimeUpdates: true, independentRuntimeVersion: true } })
  await page.route(new RegExp(`/runtime/projects/${projectId}/versions$`), route => route.fulfill({ json: {
    selectable: true, current: "2.0.0-alpha.18", latest: "2.0.0-alpha.18", versions: [
      { version: "2.0.0-alpha.18", status: "available" }, { version: "2.0.0-alpha.17", status: "available" },
      { version: "2.0.0-alpha.16", status: "unavailable" },
    ],
  } }))
  let posted: unknown
  await page.route(new RegExp(`/runtime/projects/${projectId}/version$`), async route => {
    posted = route.request().postDataJSON()
    await route.fulfill({ json: { project: { id: projectId, engineVersion: "2.0.0-alpha.17", runtime: { status: "running" } } } })
  })
  await page.goto(`${basePath}/projects`)
  await page.getByRole("button", { name: "Manage version" }).first().click()
  const picker = page.getByRole("combobox", { name: "Zelavis version" })
  await expect(picker).toBeVisible()
  await picker.selectOption("2.0.0-alpha.17")
  await expect(page).toHaveURL(/engineVersion=2\.0\.0-alpha\.17/)
  await page.reload()
  await expect(picker).toHaveValue("2.0.0-alpha.17")
  await expect(picker.locator('option[value="2.0.0-alpha.16"]')).toBeDisabled()
  await page.getByRole("button", { name: "Switch version", exact: true }).click()
  await expect.poll(() => posted).toEqual({ version: "2.0.0-alpha.17" })
  await expect(page.getByRole("button", { name: "Manage version" }).first()).toBeVisible()
})

test("@smoke App creation defaults to latest and can select an older installed engine", async ({ page }) => {
  await page.route(/\/runtime\/project-versions$/, route => route.fulfill({ json: {
    selectable: true, latest: "2.0.0-alpha.18", versions: [
      { version: "2.0.0-alpha.18", status: "available" }, { version: "2.0.0-alpha.17", status: "available" },
    ],
  } }))
  let posted: unknown
  await page.route(/\/runtime\/projects$/, async route => {
    if (route.request().method() !== "POST") return route.continue()
    posted = route.request().postDataJSON()
    await route.fulfill({ status: 201, json: { project: {
      id: "historical-ui", name: "Historical UI", runtime: { status: "running" },
      recipe: { name: "@zelavis/app", title: "Zelavis App", version: "1.0.1-alpha.17" },
    } } })
  })
  await page.goto(`${basePath}/projects?new=1&recipe=%40zelavis%2Fapp`)
  const picker = page.getByRole("combobox", { name: "Zelavis version" })
  await expect(picker).toHaveValue("")
  await expect(picker.locator('option[value=""]')).toContainText("Latest available (2.0.0-alpha.18)")
  await picker.selectOption("2.0.0-alpha.17")
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Historical UI")
  await page.getByRole("button", { name: "Create", exact: true }).click()
  await expect.poll(() => posted).toEqual({ name: "Historical UI", recipeName: "@zelavis/app", start: true, engineVersion: "2.0.0-alpha.17" })
  await expect(page.getByText("Historical UI is running in its own project runtime.")).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Zelavis version" })).toHaveCount(0)
})


test("@smoke a running managed app updates its integration without lifecycle commands", async ({ page }) => {
  test.skip(!projectId, "needs the e2e Project")
  await pretendStale(page, {
    kind: "wordpress", recipe: { name: "@zelavis/wordpress", title: "WordPress", version: "1.0.0", runtimeKinds: ["native"], managed: { adminTitle: "WordPress Admin", adminPath: "/wp-admin/" } },
    recipeStatus: { state: "upgradeAvailable", version: "2.0.0" },
    capabilities: { zeroDowntimeUpdates: true, recipeUpdateMode: "integration" },
  })
  let updates = 0, interruptions = 0
  await page.route(new RegExp(`/runtime/projects/${projectId}/upgrade$`), async route => {
    updates++
    await route.fulfill({ json: { project: {
      id: projectId, name: "Zelavis Runtime", kind: "wordpress", runtimeKind: "native",
      recipe: { name: "@zelavis/wordpress", title: "WordPress", version: "2.0.0", managed: { adminTitle: "WordPress Admin", adminPath: "/wp-admin/" } },
      runtime: { status: "running" }, capabilities: { zeroDowntimeUpdates: true, recipeUpdateMode: "integration" },
    } } })
  })
  await page.route(new RegExp(`/runtime/projects/${projectId}/(start|stop|restart)$`), async route => {
    interruptions++
    await route.fulfill({ status: 409, json: { error: "Integration updates must not interrupt the app" } })
  })
  await page.goto(`${basePath}/projects`)
  const notice = page.getByLabel("Recipe upgrade")
  await expect(notice).toContainText("The app manages its own software updates")
  await expect(notice.getByRole("button", { name: "Update recipe", exact: true })).toBeEnabled()
  await notice.getByRole("button", { name: "Update recipe", exact: true }).click()
  await expect.poll(() => updates).toBe(1)
  await expect(page.getByText("Zelavis Runtime now uses @zelavis/wordpress 2.0.0. Its data is unchanged. It is running at the same address.")).toBeVisible()
  expect(interruptions).toBe(0)
})

test("@smoke managed recipe SDK menus and pages refresh through their Project Gateway", async ({ page }) => {
  test.skip(!projectId, "needs the e2e Project")
  let revision = 1, interruptions = 0
  const recipe = () => ({ name: "@acme/site", title: "Managed site", version: `${revision}.0.0`, runtimeKinds: ["native"], managed: { adminTitle: "App Admin" } })
  await page.route(/\/runtime\/projects$/, async route => {
    if (route.request().method() !== "GET") return route.continue()
    const response = await route.fetch(), body = await response.json()
    body.projects = body.projects.map((project: { id: string }) => project.id === projectId ? {
      ...project, kind: "managed-site", recipe: recipe(), capabilities: { zeroDowntimeUpdates: true, recipeUpdateMode: "integration" },
      recipeStatus: revision === 1 ? { state: "upgradeAvailable", version: "2.0.0" } : { state: "current" },
    } : project)
    await route.fulfill({ response, json: body })
  })
  const proxy = `/zelavis/api/v1/runtime/projects/${projectId}/proxy`
  await page.route(new RegExp(`/projects/${projectId}/proxy/zelavis/api/v1/runtime/config$`), async route => {
    const response = await route.fetch(), body = await response.json()
    const menu = { title: `Integration ${revision}`, path: "/integration", surface: "root",
      page: { id: "integration", src: "/zelavis/api/v1/runtime/service-page-assets/%40acme%2Fsite/dashboard/index.html" } }
    body.services = [{ name: "@acme/site", scope: "system", kind: "app", apiPath: "/zelavis/api/v1/plugins/site", menus: [menu] }]
    body.serviceRegistry = [{ name: "@acme/site", version: recipe().version, status: "installed", source: "community", menu }]
    body.capabilities = { ...body.capabilities, database: { available: false }, identity: { available: false }, workloads: { available: false }, storage: { available: false } }
    await route.fulfill({ response, json: body })
  })
  const assetUrls: string[] = []
  await page.route(/\/service-page-assets\/%40acme%2Fsite\/dashboard\/index.html/, route => {
    assetUrls.push(route.request().url())
    return route.fulfill({ contentType: "text/html", body: `<h1>Integration asset ${revision}</h1>` })
  })
  await page.route(new RegExp(`/runtime/projects/${projectId}/upgrade$`), route => {
    revision = 2
    return route.fulfill({ json: { project: { id: projectId, recipe: recipe(), runtime: { status: "running" } } } })
  })
  await page.route(new RegExp(`/runtime/projects/${projectId}/(start|stop|restart)$`), route => {
    interruptions++; return route.fulfill({ status: 409, json: { error: "No app lifecycle call permitted" } })
  })
  await page.goto(`${basePath}/projects/${projectId}/integration`)
  await expect(page.getByText("Integration 1", { exact: true }).first()).toBeVisible()
  await expect(page.frameLocator("iframe").first().getByRole("heading", { name: "Integration asset 1" })).toBeVisible()
  await page.goto(`${basePath}/projects`)
  await page.getByLabel("Recipe upgrade").getByRole("button", { name: "Update recipe", exact: true }).click()
  await expect.poll(() => revision).toBe(2)
  await page.goto(`${basePath}/projects/${projectId}/integration`)
  await expect(page.getByText("Integration 2", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("Integration 1", { exact: true })).toHaveCount(0)
  await expect(page.frameLocator("iframe").first().getByRole("heading", { name: "Integration asset 2" })).toBeVisible()
  expect(assetUrls.every(url => url.includes(proxy))).toBe(true)
  expect(assetUrls.some(url => url.includes("zelavisServiceVersion=1.0.0"))).toBe(true)
  expect(assetUrls.some(url => url.includes("zelavisServiceVersion=2.0.0"))).toBe(true)
  expect(interruptions).toBe(0)
})

test("@smoke @embedded Open loads a managed Project overview without probing unused APIs", async ({ page }) => {
  test.skip(!projectId, "needs the e2e Project")
  await pretendStale(page, { kind: "wordpress", recipe: { name: "@zelavis/wordpress", title: "WordPress", version: "7.1.3-alpha.2", managed: { adminTitle: "WordPress Admin", adminPath: "/wp-admin/" } } })
  await page.route(new RegExp(`/projects/${projectId}/proxy/zelavis/api/v1/runtime/config$`), async route => {
    const response = await route.fetch(), body = await response.json()
    body.capabilities = { ...body.capabilities, database: { available: true, used: false }, identity: { available: true, used: false },
      storage: { available: true, used: false }, workloads: { available: true, used: false } }
    await route.fulfill({ response, json: body })
  })
  const errors: string[] = [], probes: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route(new RegExp(`/projects/${projectId}/proxy/zelavis/api/v1/(database|auth)/`), async route => {
    probes.push(route.request().url())
    return route.continue()
  })
  await page.goto(`${basePath}/projects`)
  await page.getByRole("button", { name: "Open", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`))
  await expect(page.getByText("Hosting controls", { exact: true })).toBeVisible()
  await expect(page.getByText("Dashboard error", { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByText("Hosting controls", { exact: true })).toBeVisible()
  expect(errors).toEqual([])
  expect(probes).toEqual([])
})

test("@smoke @embedded Open shows progress while resolving its Project runtime", async ({ page }) => {
  test.skip(!projectId, "needs the e2e Project")
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  await page.route(new RegExp(`/projects/${projectId}/proxy/zelavis/api/v1/runtime/config$`), async route => {
    await ready
    await route.continue()
  })
  await page.goto(`${basePath}/projects`)
  await page.getByRole("button", { name: "Open", exact: true }).click()
  try {
    await expect(page.getByRole("button", { name: "Opening…", exact: true })).toHaveAttribute("aria-busy", "true")
  } finally {
    release()
  }
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`))
})

test("@smoke @embedded an early navigation API failure settles Open and allows a retry", async ({ page }) => {
  test.skip(!projectId, "needs the e2e Project")
  await page.goto(`${basePath}/projects`)
  await expect(page.getByRole("button", { name: "Open", exact: true })).toBeVisible()
  await page.route(/\/runtime\/access$/, route => route.fulfill({ status: 403, json: { error: "Access temporarily unavailable" } }))
  await page.getByRole("button", { name: "Open", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`))
  await expect(page.getByText("Dashboard error", { exact: true })).toBeVisible()
  await page.unroute(/\/runtime\/access$/)
  await page.goto(`${basePath}/projects`)
  await page.getByRole("button", { name: "Open", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`))
  await expect(page.getByText("Dashboard error", { exact: true })).toHaveCount(0)
})

test("@smoke managed apps reuse native dashboard sections only after API usage", async ({ page }) => {
  test.skip(!projectId, "needs the e2e Project")
  await pretendStale(page, { kind: "wordpress", recipe: { name: "@acme/site", title: "Managed site", version: "1.0.0", managed: { adminTitle: "App Admin" } } })
  let used = false
  let prematureApiReads = 0
  const configPattern = new RegExp(`/projects/${projectId}/proxy/zelavis/api/v1/runtime/config$`)
  await page.route(configPattern, async route => {
    const response = await route.fetch(), body = await response.json()
    body.capabilities = { ...body.capabilities, database: { available: true, used }, identity: { available: true, used },
      storage: { available: true, used: false }, workloads: { available: true, used: false } }
    await route.fulfill({ response, json: body })
  })
  const nativeRequests: string[] = []
  await page.route(new RegExp(`/projects/${projectId}/proxy/zelavis/api/v1/(database|auth)/`), async route => {
    nativeRequests.push(route.request().url())
    if (!used) prematureApiReads++
    return route.continue()
  })
  await page.goto(`${basePath}/projects/${projectId}/files`)
  await expect(page.getByText("Managed app boundary", { exact: true })).toBeVisible()
  await expect(page.getByText("Users", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Backend", { exact: true })).toHaveCount(0)
  expect(prematureApiReads).toBe(0)
  used = true
  await page.reload()
  await expect(page.getByText("Users", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("Backend", { exact: true }).first()).toBeVisible()
  await page.getByText("Backend", { exact: true }).first().click()
  await expect(page.getByText("Auth", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("Database", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("Storage", { exact: true })).toHaveCount(0)
  await page.getByText("Auth", { exact: true }).first().click()
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/auth`))
  await expect(page.getByText("Dashboard error", { exact: true })).toHaveCount(0)
  expect(nativeRequests.some(url => url.includes("/auth/"))).toBe(true)
  expect(nativeRequests.every(url => url.includes(`/projects/${projectId}/proxy/`))).toBe(true)
  await page.goto(`${basePath}/projects`)
  await expect(page.getByRole("button", { name: "Open", exact: true })).toHaveCount(1)
})
