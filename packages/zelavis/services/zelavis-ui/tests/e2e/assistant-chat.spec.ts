import { expect, test } from "@playwright/test"

const basePath = (process.env.ZELAVIS_UI_BASE_PATH ?? "/").replace(/\/+$/, "")

test("@smoke the Assistant answers through the streaming endpoint and keeps the reply", async ({ page }) => {
  let streamed = 0
  page.on("request", (request) => {
    if (request.url().endsWith("/messages/stream")) streamed += 1
  })

  await page.goto(`${basePath}/assistant`)
  await page.getByLabel("Message input").fill("show resources")
  await page.getByRole("button", { name: "Send message" }).click()

  await expect(page.getByText("Host usage and resource charts")).toBeVisible()
  await expect(page.getByRole("button", { name: "Open Resources" })).toBeVisible()
  expect(streamed).toBe(1)

  // The saved thread, not just the live view, holds the reply.
  await page.reload()
  await expect(page.getByText("Host usage and resource charts")).toBeVisible()
})

test("@smoke tool activity shows what the Assistant checked, including what it was not allowed to", async ({ page }) => {
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  const reply = { id: "m2", role: "assistant", content: "One Project is running.", createdAt: new Date().toISOString(),
    activity: [
      { label: "Listing Projects", status: "done" },
      { label: "Reading logs for secret-project", status: "refused" },
    ] }
  await page.route("**/messages/stream", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body:
        frame("tool", { type: "tool", id: "1", name: "list_projects", label: "Listing Projects", status: "running" }) +
        frame("tool", { type: "tool", id: "1", name: "list_projects", label: "Listing Projects", status: "done" }) +
        frame("tool", { type: "tool", id: "2", name: "project_logs", label: "Reading logs for secret-project", status: "running" }) +
        frame("tool", { type: "tool", id: "2", name: "project_logs", label: "Reading logs for secret-project", status: "refused" }) +
        frame("text", { type: "text", delta: "One Project is running." }) +
        frame("done", { type: "done", thread: { id: "t" }, userMessage: { id: "m1", role: "user", content: "x", createdAt: reply.createdAt }, assistantMessage: reply }),
    }),
  )

  await page.goto(`${basePath}/assistant`)
  await page.getByLabel("Message input").fill("how are my projects")
  await page.getByRole("button", { name: "Send message" }).click()

  const checked = page.getByRole("list", { name: "What the Assistant checked" })
  await expect(checked.getByText("Listing Projects")).toBeVisible()
  await expect(checked.getByText("Not allowed: Reading logs for secret-project")).toBeVisible()
  await expect(page.getByText("One Project is running.")).toBeVisible()
})
