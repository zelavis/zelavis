import { expect, test } from "@playwright/test";

const basePath = (process.env.ZELAVIS_UI_BASE_PATH ?? "/").replace(/\/+$/, "");
const secret = "sk-or-e2e-not-a-real-key";

test("@smoke an owner saves and removes the Assistant model without the key coming back", async ({ page }) => {
  await page.goto(`${basePath}/settings`);
  await expect(page.getByText("Assistant model").first()).toBeVisible();

  await page.getByLabel("Provider").selectOption("anthropic");
  await page.getByLabel("Model").fill("vendor/e2e-model");
  await page.getByLabel("API key").fill(secret);
  await page.getByRole("button", { name: "Save", exact: true }).last().click();

  await expect(page.getByText("Provider saved")).toBeVisible();
  await expect(page.getByText("vendor/e2e-model via Anthropic")).toBeVisible();
  // Write-only: emptied after saving, and never rendered back.
  await expect(page.getByLabel("API key")).toHaveValue("");
  expect(await page.content()).not.toContain(secret);

  await page.reload();
  await expect(page.getByText("Saved in this dashboard")).toBeVisible();
  expect(await page.content()).not.toContain(secret);

  // Saving the provider is itself recorded, and the audit trail shows it
  // without the key.
  const activity = page.getByRole("table", { name: "Assistant activity" })
  await expect(activity.getByText("assistant.provider.set")).toBeVisible()
  expect(await page.content()).not.toContain(secret)

  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Provider removed")).toBeVisible();
  await expect(page.getByText("Not configured")).toBeVisible();
});

test("@smoke a Project can bring its own provider without touching the installation's", async ({ page }) => {
  const projectId = process.env.ZELAVIS_E2E_PROJECT_ID
  test.skip(!projectId, "needs the e2e Project")
  await page.goto(`${basePath}/projects/${projectId}/settings`)
  await expect(page.getByText("Assistant model for this Project")).toBeVisible()
  await expect(page.getByText(/Not configured|Using the installation's provider/)).toBeVisible()

  await page.getByLabel("Provider").selectOption("openai")
  await page.getByLabel("Model").fill("gpt-e2e")
  await page.getByLabel("API key").fill(secret)
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByText("Provider saved")).toBeVisible()
  await expect(page.getByText("This Project's own provider · gpt-e2e via OpenAI")).toBeVisible()
  await expect(page.getByLabel("API key")).toHaveValue("")
  expect(await page.content()).not.toContain(secret)

  // The installation's own setting is untouched by the Project's.
  await page.goto(`${basePath}/settings`)
  await expect(page.getByText("Not configured")).toBeVisible()

  await page.goto(`${basePath}/projects/${projectId}/settings`)
  await page.getByRole("button", { name: "Remove" }).click()
  await expect(page.getByText("This Project's provider was removed")).toBeVisible()
})
