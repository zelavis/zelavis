import assert from "node:assert/strict";

export async function qualifyCapacity(page, request, { base, endpoint, secret }) {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`${base}/server/fabric/infrastructure/providers?sidebarView=content`);
    const policy = page.locator("[data-cloud-policy]");
    await policy.getByLabel("Policy location", { exact: true }).fill("rack-a");
    await policy.getByLabel("Machine image", { exact: true }).fill("worker-image");
    await policy.getByLabel("Maximum nodes", { exact: true }).fill("3");
    await policy.getByRole("button", { name: "Add machine class", exact: true }).click();
    assert.equal(await policy.locator("[data-machine-class]").count(), 2);
    await policy.locator("[data-machine-class]").last().getByRole("button", { name: "Remove machine class" }).click();
    await policy.getByLabel("Class name", { exact: true }).fill("small");
    await policy.getByLabel("CPU cores", { exact: true }).fill("2");
    await policy.getByLabel("Memory (GiB)", { exact: true }).fill("2");
    await policy.getByLabel("Disk (GiB)", { exact: true }).fill("40");
    await policy.getByRole("button", { name: "Save machine policy", exact: true }).click();
    await page.getByText("Machine policy saved.", { exact: true }).waitFor();
    const saved = await request("/runtime/cloud/policy");
    assert.equal(saved.policy.maxNodes, 3);
    assert.deepEqual(saved.policy.machineClasses, [{ name: "small", cpuCores: 2, memoryBytes: 2 * 1024 ** 3, diskBytes: 40 * 1024 ** 3 }]);
    await page.reload(); await policy.getByLabel("Policy location", { exact: true }).waitFor();
    assert.equal(await policy.getByLabel("Policy location", { exact: true }).inputValue(), "rack-a");
    await page.locator('[data-dropdown="Provider"]').getByLabel("Provider", { exact: true }).click();
    await page.getByRole("option", { name: "Your own automation (webhook)", exact: true }).click();
    await page.getByLabel("Endpoint (https)", { exact: true }).fill(endpoint);
    await page.getByLabel("Signing secret", { exact: true }).fill(secret);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByText(new RegExp(new URL(endpoint).host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).waitFor();
    const connected = (await request("/runtime/cloud")).connection;
    assert.equal(connected.endpoint, endpoint); assert.equal(connected.provider, "webhook");
    assert.ok(!JSON.stringify(connected).includes(secret));
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await page.getByRole("button", { name: "Connect", exact: true }).waitFor();
    assert.equal((await request("/runtime/cloud")).connection, null);
  }
  console.log("Cloud capacity: persisted machine policy and signed HTTPS webhook connection passed at desktop and mobile sizes.");
}
