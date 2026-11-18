import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zelavis, createMemorySystemStore } from "../../../packages/zelavis/dist/index.js";
import { loadEcommercePlugin } from "./load-plugin.mjs";
const cleanups = new WeakMap();
export const owner = { id: "operator", type: "user", permissions: ["*"] };
export const line = { name: "Hosting", amount: 1200, currency: "USD", quantity: 1, interval: "month" };
export async function billing(t, options = {}) {
  let cleanup = cleanups.get(t);
  if (!cleanup) {
    cleanup = { runtimes: [], directories: new Set() }; cleanups.set(t, cleanup);
    t.after(async () => {
      for (const runtime of cleanup.runtimes.reverse()) await runtime.close();
      for (const directory of cleanup.directories) rmSync(directory, { recursive: true, force: true });
    });
  }
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), "zv-billing-"));
  if (!options.directory) cleanup.directories.add(directory);
  let api;
  const provider = {
    createPayment: async () => { throw new Error("Not used"); },
    createCheckout: async input => ({ reference: `cs_${input.checkoutId}`, url: "https://checkout.example/session", customerReference: "cus_provider" }),
    createPortal: async input => ({ url: `https://billing.example/${input.customerReference}` }),
    parseWebhook: async ({ headers, rawBody }) => {
      if (headers.get("signature") !== "valid") { const { InvalidWebhook } = await import("../dist/errors.js"); throw new InvalidWebhook({}); }
      return JSON.parse(rawBody).map(e => ({ ...e, occurredAt: new Date(e.occurredAt) }));
    },
    ...options.provider,
  };
  const capture = { name: "@test/payment", namespace: "testPayment", kind: "plugin", capabilities: ["@zelavis/ecommerce:payments"], service: { register(value) { api = value; return value.runPromise(value.payments.registerProvider("fake", provider)); } } };
  const runtime = await zelavis({
    systemStore: createMemorySystemStore(), subsystems: { database: { directory } },
    serviceRegistry: { catalog: [{ service: await loadEcommercePlugin(), status: "installed" }, { service: capture, status: "installed" }, ...(options.handlers ?? [])] },
  });
  cleanup.runtimes.push(runtime);
  const request = (path, method = "GET", body, principal = owner) => runtime.plain({ url: `/zelavis/api/v1/plugins/ecommerce${path}`, method, body, principal });
  return { runtime, api, directory, request, provider };
}
export async function checkout(fixture) {
  await fixture.request("/customers", "POST", { id: "customer", email: "user@example.com", principalId: "user" });
  return fixture.request("/checkouts", "POST", { provider: "fake", customerId: "customer", mode: "subscription", lines: [line], successUrl: "https://shop.example/success", cancelUrl: "https://shop.example/cancel", metadata: { plan: "hosting" } });
}
