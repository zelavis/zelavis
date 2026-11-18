import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { once } from "node:events";
import test from "node:test";
import { createNodeServer, closeNodeServer } from "../../../packages/zelavis/dist/runtimes/node.js";
import { zelavisUiFrontend } from "../../../packages/zelavis/services/zelavis-ui/dist/frontend.js";
import { password, readyBilling } from "./billing-fixture.mjs";

const { chromium } = createRequire(new URL("../../../packages/zelavis/services/zelavis-ui/package.json", import.meta.url))("@playwright/test");

test("Hosting settings, plans, subscriptions and billing actions work in opaque dashboard frames", async t => {
  const fixture = await readyBilling(t, { frontend: zelavisUiFrontend, projects: { previewHost: false } });
  const server = await createNodeServer(fixture.instance);
  let browser;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      page.setDefaultTimeout(15_000);
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      const session = (method, data) => page.request.post(`${origin}/zelavis/api/v1/auth/${method}`, {
        headers: { origin }, data,
      });
      const owner = await session("username-password/sign-in", { username: "owner", password });
      assert.equal(owner.status(), 200);
      const response = await page.goto(`${origin}/zelavis/hosting/plans`);
      assert.equal(response.status(), 200);
      const browserConfig = await page.evaluate(() => fetch("/zelavis/api/v1/runtime/config").then(response => response.json()));
      assert.ok(browserConfig.services.some(service => service.name === "@zelavis/hosting" && service.menu?.page),
        `browser config had ${browserConfig.services.map(service => service.name).join(", ")}`);
      const listed = browserConfig.services.find(service => service.name === "@zelavis/hosting");
      assert.equal(listed.scope, "extension", JSON.stringify(listed));
      assert.equal(listed.menu.items[0].path, "/hosting/plans", JSON.stringify(listed.menu));
      const operator = page.frameLocator('iframe[title="Plans and settings"]');
      try {
        assert.match(await page.locator("iframe").getAttribute("sandbox"), /^allow-scripts allow-forms$/u);
      } catch (error) {
        throw new Error(`Hosting frame missing at ${new URL(page.url()).pathname}: ${(await page.locator("body").innerText()).slice(0, 700)}`, { cause: error });
      }
      await operator.getByRole("button", { name: "Edit Starter" }).waitFor();
      await operator.getByLabel("Grace days").fill("5");
      await operator.getByRole("button", { name: "Save settings" }).click();
      await operator.getByText("Settings saved.", { exact: true }).waitFor();
      await operator.getByRole("button", { name: "New plan" }).click();
      await operator.getByLabel("Plan ID").fill(`plus-${viewport.width}`);
      await operator.getByLabel("Title", { exact: true }).fill(`Plus ${viewport.width}`);
      await operator.getByLabel("Price in minor units").fill("2400");
      await operator.getByLabel("Project limit").fill("2");
      await operator.getByRole("button", { name: "Save plan" }).click();
      await operator.getByText("Plan saved.", { exact: true }).waitFor();
      await page.reload();
      await operator.getByRole("button", { name: `Edit Plus ${viewport.width}` }).waitFor();
      assert.equal(await operator.getByLabel("Grace days").inputValue(), "5");

      const name = `browser-${viewport.width}`;
      const member = await fixture.createCustomer(name);
      await page.context().clearCookies();
      const signIn = () => session("email-password/sign-in", { email: `${name}@example.test`, password });
      assert.equal((await signIn()).status(), 200);
      await page.goto(`${origin}/zelavis/hosting`);
      const customer = page.frameLocator('iframe[title="Hosting Provider"]');
      assert.equal(await customer.locator("main").evaluate(() => window.origin), "null");
      await customer.getByRole("button", { name: "Subscribe to Starter" }).click();
      const dialog = page.getByRole("dialog", { name: "Open external link" });
      const link = dialog.getByRole("link", { name: "Open checkout.example" });
      await link.waitFor();
      assert.match(await link.getAttribute("href"), /^https:\/\/checkout\.example\//u);
      assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
      await page.context().route("https://checkout.example/**", route => route.fulfill({ body: "Test hosted checkout" }));
      const opened = page.context().waitForEvent("page");
      await link.click();
      const payment = await opened;
      await payment.getByText("Test hosted checkout").waitFor();
      assert.equal(await payment.evaluate(() => window.opener), null);
      await payment.close();
      await customer.getByText("Your payment link is ready in the dashboard.", { exact: true }).waitFor();
      await fixture.complete();
      await page.reload();
      await customer.getByText("Starter · Active", { exact: true }).waitFor();
      await customer.getByText("0 of 2 Projects", { exact: true }).waitFor();
      await customer.getByRole("button", { name: "Manage billing" }).click();
      await dialog.getByRole("link", { name: "Open billing.example" }).waitFor();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await customer.getByLabel("Project name").fill(`Hosted ${viewport.width}`);
      await customer.getByRole("button", { name: "Create Project" }).click();
      await customer.getByText(/Project h-[a-z2-7]{12} created/).waitFor();
      assert.equal((await signIn()).status(), 200);
      await page.reload();
      await customer.getByText("1 of 2 Projects", { exact: true }).waitFor();
      await customer.getByText(`Hosted ${viewport.width} · running`, { exact: true }).waitFor();

      await page.context().clearCookies();
      assert.equal((await session("username-password/sign-in", { username: "owner", password })).status(), 200);
      await page.goto(`${origin}/zelavis/hosting/subscriptions`);
      const subscriptions = page.frameLocator('iframe[title="Subscriptions"]');
      const row = subscriptions.getByRole("row").filter({ hasText: member.id });
      await row.getByRole("cell", { name: "Active", exact: true }).waitFor();
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser?.close();
    await closeNodeServer(server);
  }
});
