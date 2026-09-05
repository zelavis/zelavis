import assert from "node:assert/strict";
import test from "node:test";
import { loadEcommercePlugin } from "./helpers/ecommerce.mjs";
import { stripeService } from "../../../plugins/ecommerce/plugins/stripe/dist/index.js";
import { paypalService } from "../../../plugins/ecommerce/plugins/paypal/dist/index.js";
import { createMemorySystemStore, zelavis } from "../dist/index.js";

const OWNER = { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] };

async function platform({ withPaypal = false } = {}) {
  return zelavis({
    systemStore: createMemorySystemStore(),
    resolvePrincipal: () => OWNER,
    serviceRegistry: {
      catalog: [
        { service: await loadEcommercePlugin(), status: "installed", source: "official" },
        {
          service: stripeService({ secretKey: "sk_test_x", webhookSecret: "whsec_x" }),
          status: "installed",
          source: "official",
        },
        ...(withPaypal
          ? [
              {
                service: paypalService({ clientId: "id", clientSecret: "secret" }),
                status: "available",
                source: "official",
              },
            ]
          : []),
      ],
    },
  });
}

async function ecommerceMenu(runtime) {
  const config = await runtime.plain({ url: "/zelavis/api/v1/runtime/config" });
  return config.body.services.find((service) => service.name === "@zelavis/ecommerce")
    ?.menu;
}

test("the plugin's menu reaches the dashboard", async () => {
  const runtime = await platform();
  const menu = await ecommerceMenu(runtime);

  // The plugin adds its routes during setup, so it carries no basePath,
  // service or routes of its own — and the mount check skipped it, dropping a
  // menu with five pages while everything looked installed.
  assert.ok(menu, "@zelavis/ecommerce should contribute a menu");
  assert.equal(menu.title, "Ecommerce");
  assert.ok(menu.items.some((item) => item.title === "Payments"));
});

test("every page the menu offers actually serves", async () => {
  const runtime = await platform();
  const menu = await ecommerceMenu(runtime);
  const pages = [menu, ...menu.items].filter((item) => item.page?.src);

  // They pointed at `bundle: "dashboard"`, which resolves through the bundle
  // store, and nothing uploaded them into one — so every page answered
  // "Service asset not found".
  assert.ok(pages.length >= 4);
  for (const item of pages) {
    const response = await runtime.plain({ url: item.page.src });
    assert.equal(response.status, 200, `${item.page.id} answered ${response.status}`);
    assert.match(response.headers["content-type"], /text\/html/u);
  }
});

test("the payments page reads the gateways this plugin owns", async () => {
  const runtime = await platform();
  const menu = await ecommerceMenu(runtime);
  const payments = menu.items.find((item) => item.title === "Payments");
  const html = String((await runtime.plain({ url: payments.page.src })).body);

  assert.match(html, /\/commerce\/payments\/providers/u);
  // Scoped to this plugin. A catalogue asking for the wrong owner lists
  // nothing while looking like it worked.
  assert.match(html, /const OWNER = "@zelavis\/ecommerce"/u);
  assert.match(html, /runtime\/extensions\?owner=/u);
});

test("the catalogue separates installed gateways from available ones", async () => {
  const runtime = await platform({ withPaypal: true });
  const response = await runtime.plain({
    url: `/zelavis/api/v1/runtime/extensions?owner=${encodeURIComponent("@zelavis/ecommerce")}`,
  });

  const byName = Object.fromEntries(
    response.body.extensionPoints[0].extensions.map((extension) => [
      extension.name,
      extension,
    ]),
  );
  assert.equal(byName["@zelavis/ecommerce-stripe"].status, "installed");
  assert.equal(byName["@zelavis/ecommerce-paypal"].status, "available");
  // Named for a catalogue: a list of package names tells an operator less
  // than the gateway they are choosing between.
  assert.equal(byName["@zelavis/ecommerce-stripe"].marketplace.title, "Stripe");
  assert.equal(byName["@zelavis/ecommerce-paypal"].marketplace.title, "PayPal");
});

test("a service contributing only a menu is mounted", async () => {
  const runtime = await zelavis({
    systemStore: createMemorySystemStore(),
    resolvePrincipal: () => OWNER,
    serviceRegistry: {
      catalog: [
        {
          service: {
            name: "@acme/menu-only",
            kind: "plugin",
            menu: { title: "Acme", path: "/acme" },
          },
          status: "installed",
          source: "community",
        },
      ],
    },
  });

  const config = await runtime.plain({ url: "/zelavis/api/v1/runtime/config" });
  assert.ok(
    config.body.services.some((service) => service.name === "@acme/menu-only"),
    "a menu is a contribution, so a service declaring only one still mounts",
  );
});
