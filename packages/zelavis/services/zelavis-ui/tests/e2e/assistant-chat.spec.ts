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
