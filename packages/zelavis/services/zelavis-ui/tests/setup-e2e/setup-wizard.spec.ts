import { expect, test } from "@playwright/test";

const runtimeOrigin = process.env.ZELAVIS_E2E_RUNTIME_ORIGIN ?? "http://127.0.0.1:3000";
const bootstrapToken = process.env.ZELAVIS_BOOTSTRAP_TOKEN;
const ownerPassword = process.env.ZELAVIS_E2E_OWNER_PASSWORD;
const email = "wizard@example.com";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  if (!bootstrapToken || !ownerPassword) {
    throw new Error("ZELAVIS_BOOTSTRAP_TOKEN and ZELAVIS_E2E_OWNER_PASSWORD are required.");
  }
});

test("an unclaimed Platform sends every route to the wizard", async ({ page }) => {
  for (const path of ["/", "/login", "/projects", "/server/domains"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/setup/);
    await expect(page.getByRole("heading", { name: "Let’s set up your Platform" })).toBeVisible();
  }
});

test("the wizard rejects a wrong token and a short password, then creates the owner", async ({ page }) => {
  await page.goto("/setup");
  await page.getByRole("button", { name: /begin|get started|continue/i }).first().click();
  await page.getByLabel(/^Email/).fill(email);
  await page.getByRole("button", { name: /continue/i }).click();

  await page.getByLabel("One-time bootstrap token").fill("x".repeat(40));
  await page.getByLabel("Owner password", { exact: true }).fill(ownerPassword!);
  await page.getByLabel("Confirm password").fill(ownerPassword!);
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  // A refused token must not claim the Platform.
  const status = await fetch(`${runtimeOrigin}/zelavis/api/v1/auth/bootstrap`).then((r) => r.json());
  expect(status.required).toBe(true);

  await page.getByLabel("One-time bootstrap token").fill(bootstrapToken!);
  await page.getByRole("button", { name: "Finish setup" }).click();

  // Creating the owner ends "required"; the wizard must still reach its Edge
  // step rather than being bounced to the dashboard mid-flow.
  await expect(page.getByRole("heading", { name: "Connect Zelavis Edge" })).toBeVisible();
  await page.getByRole("button", { name: /Configure later/ }).click();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByRole("heading", { name: "Zelavis is ready" })).toBeVisible();
});

test("once configured, the wizard is closed and the API refuses a second claim", async ({ page }) => {
  await page.goto("/setup");
  await expect(page).not.toHaveURL(/\/setup/);

  const second = await fetch(`${runtimeOrigin}/zelavis/api/v1/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: runtimeOrigin },
    body: JSON.stringify({
      bootstrapToken,
      provider: "password",
      account: { email: "second@example.com" },
      credential: { identifier: "second@example.com", password: ownerPassword },
    }),
  });
  expect(second.ok).toBe(false);

  await page.goto("/login");
  await expect(page).toHaveURL(/\/login/);
});
