import { expect, test } from "@playwright/test";

const basePath = (process.env.ZELAVIS_UI_BASE_PATH ?? "/").replace(/\/+$/, "");
const secret = "sk-or-e2e-not-a-real-key";

test("@smoke an owner saves and removes the Assistant model without the key coming back", async ({ page }) => {
  await page.goto(`${basePath}/settings`);
  await expect(page.getByText("Assistant model").first()).toBeVisible();

  await page.getByLabel("Model").fill("vendor/e2e-model");
  await page.getByLabel("OpenRouter API key").fill(secret);
  await page.getByRole("button", { name: "Save", exact: true }).last().click();

  await expect(page.getByText("Provider saved")).toBeVisible();
  await expect(page.getByText("vendor/e2e-model via OpenRouter")).toBeVisible();
  // Write-only: emptied after saving, and never rendered back.
  await expect(page.getByLabel("OpenRouter API key")).toHaveValue("");
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
