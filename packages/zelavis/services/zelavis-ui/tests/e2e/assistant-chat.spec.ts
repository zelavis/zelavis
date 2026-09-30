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

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

async function scriptApproval(page: import("@playwright/test").Page, approval: {
  id: string; label: string; irreversible: boolean; target: { kind: string; id: string }
}) {
  const createdAt = new Date().toISOString()
  await page.route("**/messages/stream", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body:
        sse("tool", { type: "tool", id: "1", name: "x", label: approval.label, status: "running" }) +
        sse("tool", { type: "tool", id: "1", name: "x", label: approval.label, status: "awaiting" }) +
        sse("approval", { type: "approval", ...approval }) +
        sse("text", { type: "text", delta: "I asked for your approval." }) +
        sse("done", {
          type: "done",
          thread: { id: "t" },
          userMessage: { id: "m1", role: "user", content: "x", createdAt },
          assistantMessage: {
            id: "m2", role: "assistant", content: "I asked for your approval.", createdAt,
            activity: [{ label: approval.label, status: "awaiting" }],
            approvalIds: [approval.id],
          },
        }),
    }),
  )
}

test("@smoke a requested change waits for a person, with nothing focused", async ({ page }) => {
  await scriptApproval(page, {
    id: "approval_1", label: "Stop Project site-a", irreversible: false, target: { kind: "project", id: "site-a" },
  })
  let decision: unknown
  await page.route("**/approvals/approval_1", async (route) => {
    decision = route.request().postDataJSON()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        approval: { id: "approval_1", threadId: "t", label: "Stop Project site-a", irreversible: false,
          target: { kind: "project", id: "site-a" }, status: "executed", expiresAt: "", outcome: "Done: Stop Project site-a." },
        message: { id: "m3", role: "assistant", content: "Done: Stop Project site-a.", createdAt: new Date().toISOString() },
      }),
    })
  })

  await page.goto(`${basePath}/assistant`)
  await page.getByLabel("Message input").fill("stop site-a")
  await page.getByRole("button", { name: "Send message" }).click()

  const card = page.getByRole("region", { name: "Approval needed" })
  await expect(card.getByText("Stop Project site-a")).toBeVisible()
  await expect(card.getByText("site-a", { exact: true })).toBeVisible()
  await expect(page.getByText("Waiting for your approval: Stop Project site-a")).toBeVisible()
  // No default action: neither button holds focus, so Enter approves nothing.
  const focusedInCard = await card.evaluate((element) => element.contains(document.activeElement))
  expect(focusedInCard).toBe(false)

  await card.getByRole("button", { name: "Approve" }).click()
  await expect(card.getByText("Approved. Done: Stop Project site-a.")).toBeVisible()
  expect(decision).toEqual({ decision: "approve" })
})

test("@smoke an irreversible change must be confirmed by typing its id", async ({ page }) => {
  await scriptApproval(page, {
    id: "approval_2", label: "Delete Project site-a", irreversible: true, target: { kind: "project", id: "site-a" },
  })
  let decision: unknown
  await page.route("**/approvals/approval_2", async (route) => {
    decision = route.request().postDataJSON()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        approval: { id: "approval_2", threadId: "t", label: "Delete Project site-a", irreversible: true,
          target: { kind: "project", id: "site-a" }, status: "denied", expiresAt: "", outcome: "Nothing was changed." },
        message: { id: "m3", role: "assistant", content: "Understood.", createdAt: new Date().toISOString() },
      }),
    })
  })

  await page.goto(`${basePath}/assistant`)
  await page.getByLabel("Message input").fill("delete site-a")
  await page.getByRole("button", { name: "Send message" }).click()

  const card = page.getByRole("region", { name: "Approval needed" })
  await expect(card.getByRole("alert").filter({ hasText: "This cannot be undone." })).toBeVisible()
  const approve = card.getByRole("button", { name: "Approve" })
  await expect(approve).toBeDisabled()
  await card.getByLabel(/Type site-a to confirm/).fill("site-b")
  await expect(approve).toBeDisabled()
  await card.getByLabel(/Type site-a to confirm/).fill("site-a")
  await expect(approve).toBeEnabled()

  await card.getByRole("button", { name: "Deny" }).click()
  await expect(card.getByText("Denied. Nothing was changed.")).toBeVisible()
  expect(decision).toEqual({ decision: "deny" })
})
