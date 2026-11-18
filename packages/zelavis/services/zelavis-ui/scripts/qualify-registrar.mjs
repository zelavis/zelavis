import assert from "node:assert/strict";
export async function qualifyRegistrar(page, request, options) {
  const { base, fake } = options;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/server/domains?sidebarView=content`);
  const connect = page.locator("[data-registrar-connect]");
  await connect.getByLabel("API user", { exact: true }).fill("browser-user");
  await connect.getByLabel("API key", { exact: true }).fill("browser-test-key");
  await connect.getByLabel("Account username", { exact: true }).fill("browser-user");
  await connect.getByLabel("Whitelisted client IPv4", { exact: true }).fill("192.0.2.1");
  await connect.getByRole("checkbox", { name: "Use sandbox" }).check();
  await connect.getByRole("button", { name: "Connect registrar", exact: true }).click();
  await page.getByText("Registrar connected.", { exact: true }).waitFor();
  await page.getByText("Sandbox — test account", { exact: true }).waitFor();
  const contact = page.locator("[data-registrar-contact]");
  for (const [name, value] of Object.entries({ firstName: "Test", lastName: "Owner", address1: "1 Test Street", city: "City", stateProvince: "CA", postalCode: "90001", country: "US", phone: "+1.5555550100", email: "owner@example.com" })) await contact.locator(`input[name="${name}"]`).fill(value);
  await contact.getByRole("button", { name: "Save registrant contact", exact: true }).click();
  await page.getByText("Registrant contact saved.", { exact: true }).waitFor();
  assert.ok(!JSON.stringify(await request("/runtime/registrar/connection")).includes("browser-test-key"));
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`${base}/server/domains?sidebarView=content`);
    const domain = `browser-${viewport.width}.com`;
    await page.getByLabel("Domain to acquire or renew", { exact: true }).fill(domain);
    await page.getByRole("button", { name: "Check availability and price", exact: true }).click();
    await page.getByText("Available", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Review purchase", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm domain purchase", exact: true });
    await dialog.waitFor();
    const key = new URL(page.url()).searchParams.get("order"); assert.ok(key);
    await page.reload(); await dialog.waitFor();
    assert.equal(new URL(page.url()).searchParams.get("order"), key);
    await dialog.getByLabel("Type the domain to confirm", { exact: true }).fill("wrong.com");
    assert.equal(await dialog.getByRole("button", { name: "Confirm purchase", exact: true }).isDisabled(), true);
    await dialog.getByLabel("Type the domain to confirm", { exact: true }).fill(domain);
    await dialog.getByRole("button", { name: "Confirm purchase", exact: true }).click();
    const row = page.locator(`[data-order-key="${key}"]`);
    await row.getByText("Completed", { exact: true }).waitFor();
    await page.reload(); await row.getByText("Completed", { exact: true }).waitFor();
    assert.equal(fake.purchases.filter(item => item.domain === domain && item.kind === "register").length, 1);
    const registered = page.locator("section.k-card").filter({ has: page.getByRole("heading", { name: "Registered domains", exact: true }) }).locator(".k-row").filter({ has: page.getByText(domain, { exact: true }) });
    await registered.getByRole("button", { name: "Nameservers", exact: true }).click();
    await page.getByLabel("Nameservers (comma separated)", { exact: true }).fill("ns1.example.com,ns2.example.com");
    await page.getByRole("button", { name: "Save nameservers", exact: true }).click();
    await page.getByText("Nameservers updated.", { exact: true }).waitFor();
    assert.equal(fake.nameservers.get(domain), "ns1.example.com,ns2.example.com");
  }
  console.log("Registrar: built-in Namecheap connection, encrypted contact, typed price confirmation, reload-safe purchase and nameservers passed at desktop and mobile sizes.");
}
