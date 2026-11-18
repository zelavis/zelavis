import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const [name, directory, entry] of [["Ecommerce", "..", "payments.html"], ["Stripe", "../plugins/stripe", "settings.html"]]) {
  test(`${name} npm package includes the dashboard entry and its generated module`, () => {
    const result = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
      cwd: fileURLToPath(new URL(directory, import.meta.url)), encoding: "utf8", timeout: 30000,
    }));
    const files = new Set(result[0].files.map(file => file.path));
    assert.ok(files.has(`dashboard/${entry}`));
    assert.ok(files.has("dashboard/api.js"), "an ignored generated module still belongs in the published package");
  });
}
