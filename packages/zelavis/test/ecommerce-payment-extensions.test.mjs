import assert from "node:assert/strict";
import test from "node:test";
import { ecommercePlugin } from "../../../plugins/ecommerce/dist/index.js";
import { stripeService } from "../../../plugins/ecommerce/plugins/stripe/dist/index.js";
import { paypalService } from "../../../plugins/ecommerce/plugins/paypal/dist/index.js";
import { isServiceExtension, serviceExtensionOwners } from "../dist/core/index.js";
import { createMemorySystemStore, zelavis } from "../dist/index.js";

const OWNER = { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] };
const EXTENSIONS = "/zelavis/api/v1/runtime/extensions";

function gateways() {
  return [
    stripeService({ secretKey: "sk_test_x", webhookSecret: "whsec_x" }),
    paypalService({ clientId: "id", clientSecret: "secret" }),
  ];
}

test("a payment gateway names the plugin it extends", () => {
  for (const gateway of gateways()) {
    assert.equal(isServiceExtension(gateway), true);
    assert.deepEqual(serviceExtensionOwners(gateway), ["@zelavis/ecommerce"]);
    // Not `provider:payments`: a bare domain says what a gateway implements
    // and never whose contract it satisfies, so another commerce plugin
    // scanning for it would collect these too.
    assert.ok(!gateway.capabilities.includes("provider:payments"));
  }
});

test("a gateway declares a kind that still exists", () => {
  // Both said `kind: "provider"`, a kind removed when the taxonomy collapsed
  // to app | frontend | plugin. Manifest validation refuses it.
  for (const gateway of gateways()) {
    assert.equal(gateway.kind, "plugin");
  }
});

test("the gateways carry the manifest an install would validate", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const [name, path] of [
    ["stripe", "../../../plugins/ecommerce/plugins/stripe/package.json"],
    ["paypal", "../../../plugins/ecommerce/plugins/paypal/package.json"],
  ]) {
    const manifest = JSON.parse(
      await readFile(new URL(path, import.meta.url), "utf8"),
    );
    // Neither had a `zelavis` block at all, so installing one would have been
    // refused at validation — they only ever worked when composed in code.
    assert.equal(manifest.zelavis?.kind, "plugin", name);
    assert.deepEqual(manifest.zelavis.capabilities, ["@zelavis/ecommerce:payments"], name);
  }
});

async function platform(catalog) {
  return zelavis({
    systemStore: createMemorySystemStore(),
    resolvePrincipal: () => OWNER,
    serviceRegistry: { catalog },
  });
}

test("gateways are listed under the plugin they extend", async () => {
  const runtime = await platform([
    { service: ecommercePlugin, status: "installed", source: "official" },
    ...gateways().map((service) => ({
      service,
      status: "installed",
      source: "official",
    })),
  ]);

  const response = await runtime.plain({
    url: `${EXTENSIONS}?owner=${encodeURIComponent("@zelavis/ecommerce")}`,
  });

  assert.equal(response.status, 200);
  const point = response.body.extensionPoints[0];
  assert.equal(point.owner, "@zelavis/ecommerce");
  assert.equal(point.ownerInstalled, true);
  assert.deepEqual(point.capabilities, ["payments"]);
  assert.deepEqual(
    point.extensions.map((extension) => extension.name).sort(),
    ["@zelavis/ecommerce-paypal", "@zelavis/ecommerce-stripe"],
  );
});

test("ecommerce still discovers the gateways it lists", async () => {
  const runtime = await platform([
    { service: ecommercePlugin, status: "installed", source: "official" },
    ...gateways().map((service) => ({
      service,
      status: "installed",
      source: "official",
    })),
  ]);

  // The listing and the discovery must agree: a gateway shown as installed
  // that the plugin cannot see would be a catalogue describing nothing.
  const providers = await runtime.plain({
    url: "/zelavis/api/v1/commerce/payments/providers",
  });
  assert.equal(providers.status, 200);
  const names = providers.body.providers.map((provider) => provider.name ?? provider);
  assert.ok(names.includes("stripe"), JSON.stringify(names));
  assert.ok(names.includes("paypal"), JSON.stringify(names));
});

test("a gateway cannot be installed without the plugin it extends", async () => {
  const runtime = await platform(
    gateways().map((service) => ({
      service,
      status: "available",
      source: "official",
    })),
  );

  const refused = await runtime.plain({
    url: "/zelavis/api/v1/runtime/services/%40zelavis%2Fecommerce-stripe",
    method: "PATCH",
    body: { status: "installed" },
  });

  // A gateway is discovered by the commerce plugin. Installed on its own it
  // would look enabled and process nothing.
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /@zelavis\/ecommerce.*not installed/u);
});
