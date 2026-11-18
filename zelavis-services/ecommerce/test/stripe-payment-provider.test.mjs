import assert from "node:assert/strict";
import test from "node:test";
import { createStripePaymentProvider } from "../plugins/stripe/dist/index.js";

const input = {
  amount: 1200,
  currency: "EUR",
  order: { id: "order-1", customerId: "customer-1", couponCodes: [] },
  metadata: { source: "checkout" },
};

function fixture(options = {}) {
  const calls = [];
  const client = {
    paymentIntents: {
      async create(params, requestOptions) {
        calls.push({ params, requestOptions });
        return {
          id: "pi_test", amount: params.amount, currency: params.currency,
          status: "requires_payment_method", metadata: params.metadata,
          created: 1_700_000_000, client_secret: "test-secret",
        };
      },
    },
  };
  return { calls, provider: createStripePaymentProvider({ client, ...options }) };
}

test("Stripe 23 creates a dynamic-method PaymentIntent with order idempotency", async () => {
  const { calls, provider } = fixture();
  const payment = await provider.createPayment(input);
  assert.deepEqual(calls[0].params, {
    amount: 1200, currency: "eur",
    metadata: { orderId: "order-1", customerId: "customer-1", couponCodes: "", source: "checkout" },
    automatic_payment_methods: { enabled: true },
  });
  assert.deepEqual(calls[0].requestOptions, { idempotencyKey: "order:order-1:create-payment-intent" });
  assert.equal(payment.status, "requires_action");
  assert.equal(payment.currency, "EUR");
  assert.equal(payment.orderId, "order-1");
});

test("Stripe preserves explicit payment method and redirect configuration", async () => {
  const automatic = { enabled: true, allow_redirects: "never" };
  const { calls, provider } = fixture({
    getPaymentIntentParams: () => ({ automatic_payment_methods: automatic }),
    getCreatePaymentIdempotencyKey: () => "custom-key",
  });
  await provider.createPayment(input);
  assert.deepEqual(calls[0].params.automatic_payment_methods, automatic);
  assert.equal(calls[0].requestOptions.idempotencyKey, "custom-key");
});

test("Stripe preserves allowed methods from an asynchronous parameter hook", async () => {
  const { calls, provider } = fixture({
    getPaymentIntentParams: async () => ({ allowed_payment_method_types: ["card"] }),
  });
  await provider.createPayment(input);
  assert.deepEqual(calls[0].params.allowed_payment_method_types, ["card"]);
  assert.deepEqual(calls[0].params.automatic_payment_methods, { enabled: true });
  assert.equal(Object.hasOwn(calls[0].params, "payment_method_types"), false);
});

test("Stripe does not issue a payment when the parameter hook fails", async () => {
  const failure = new Error("configuration unavailable");
  const { calls, provider } = fixture({ getPaymentIntentParams: async () => { throw failure; } });
  await assert.rejects(provider.createPayment(input), (error) => error === failure);
  assert.equal(calls.length, 0);
});

test("Stripe payment request failures remain visible to the caller", async () => {
  const failure = new Error("payment rejected");
  const { provider } = fixture({
    client: { paymentIntents: { create: async () => { throw failure; } } },
  });
  await assert.rejects(provider.createPayment(input), (error) => error === failure);
});

test("Stripe hosted checkout, portal and signatures use the provider contract without network calls", async () => {
  const { createRequire } = await import("node:module");
  const Stripe = createRequire(new URL("../plugins/stripe/package.json", import.meta.url))("stripe");
  const signer = new Stripe("sk_test_fixture");
  const calls = [];
  const provider = createStripePaymentProvider({ webhookSecret: "whsec_fixture", client: {
    checkout: { sessions: { create: async (params, options) => { calls.push({ params, options }); return { id: "cs_hosted", url: "https://checkout.stripe.example/session", expires_at: 1900000000, customer: "cus_existing" }; } } },
    billingPortal: { sessions: { create: async params => { calls.push(params); return { url: "https://billing.stripe.example/portal" }; } } },
    webhooks: signer.webhooks,
  } });
  const checkout = await provider.createCheckout({ checkoutId: "checkout", mode: "subscription", customer: { id: "customer", email: "user@example.com", providerReferences: { stripe: "cus_existing" } }, lines: [{ name: "Hosting", amount: 1200, currency: "EUR", quantity: 2, interval: "month" }], successUrl: "https://shop.example/success", cancelUrl: "https://shop.example/cancel", metadata: { hostingPlan: "basic" } });
  assert.equal(checkout.reference, "cs_hosted");
  assert.equal(calls[0].options.idempotencyKey, "checkout:checkout");
  assert.equal(calls[0].params.customer, "cus_existing");
  assert.equal(calls[0].params.client_reference_id, "checkout");
  assert.equal(calls[0].params.subscription_data.metadata.hostingPlan, "basic");
  assert.equal(calls[0].params.line_items[0].price_data.recurring.interval_count, 1);
  assert.equal((await provider.createPortal({ customer: {}, customerReference: "cus_existing", returnUrl: "https://shop.example" })).url, "https://billing.stripe.example/portal");
  const payload = JSON.stringify({ id: "evt_signed", type: "checkout.session.completed", created: Math.floor(Date.now() / 1000), data: { object: { id: "cs_hosted", payment_status: "paid", customer: "cus_existing", subscription: "sub_existing" } } });
  const signature = signer.webhooks.generateTestHeaderString({ payload, secret: "whsec_fixture" });
  const events = await provider.parseWebhook({ rawBody: payload, headers: new Headers({ "stripe-signature": signature }) });
  assert.equal(events[0].checkoutReference, "cs_hosted");
  assert.equal(events[0].subscriptionReference, "sub_existing");
  await assert.rejects(provider.parseWebhook({ rawBody: payload + " ", headers: new Headers({ "stripe-signature": signature }) }), error => error._tag === "InvalidWebhook");
  const unknown = JSON.stringify({ id: "evt_unknown", type: "unhandled", created: Math.floor(Date.now() / 1000), data: { object: {} } });
  assert.deepEqual(await provider.parseWebhook({ rawBody: unknown, headers: new Headers({ "stripe-signature": signer.webhooks.generateTestHeaderString({ payload: unknown, secret: "whsec_fixture" }) }) }), []);
});

test("Stripe without credentials composes lazily and refuses checkout with ProviderNotConfigured", async () => {
  const provider = createStripePaymentProvider();
  await assert.rejects(provider.createCheckout({}), error => error._tag === "ProviderNotConfigured");
});

test("Stripe normalizes subscription, invoice and delayed-checkout events with signed raw fixtures", async () => {
  const { createRequire } = await import("node:module");
  const Stripe = createRequire(new URL("../plugins/stripe/package.json", import.meta.url))("stripe");
  const signer = new Stripe("sk_test_fixture");
  const provider = createStripePaymentProvider({ client: { webhooks: signer.webhooks }, webhookSecret: "whsec_fixture", credentials: async () => { throw new Error("Code options must bypass credential lookup"); } });
  const cases = [
    ["customer.subscription.updated", { id: "sub_signed", status: "past_due", cancel_at_period_end: true, items: { data: [{ current_period_start: 1700000000, current_period_end: 1702592000 }] } }, "subscription.updated"],
    ["customer.subscription.deleted", { id: "sub_signed", status: "canceled", cancel_at_period_end: false, items: { data: [] } }, "subscription.updated"],
    ["invoice.paid", { id: "in_signed", amount_paid: 1200, currency: "eur", parent: { subscription_details: { subscription: "sub_signed" } } }, "payment.succeeded"],
    ["invoice.payment_failed", { id: "in_signed", amount_due: 1200, currency: "eur", parent: { subscription_details: { subscription: "sub_signed" } } }, "payment.failed"],
    ["checkout.session.async_payment_succeeded", { id: "cs_delayed", payment_status: "paid" }, "checkout.completed"],
  ];
  for (const [type, object, expected] of cases) {
    const payload = JSON.stringify({ id: `evt_${type}`, type, created: Math.floor(Date.now()/1000), data: { object } });
    const events = await provider.parseWebhook({ rawBody: payload, headers: new Headers({ "stripe-signature": signer.webhooks.generateTestHeaderString({ payload, secret: "whsec_fixture" }) }) });
    assert.equal(events[0].type, expected);
    if (type === "customer.subscription.deleted") assert.equal(events[0].status, "cancelled");
    if (type.startsWith("invoice")) { assert.equal(events[0].subscriptionReference, "sub_signed"); assert.equal(events[0].currency, "EUR"); }
  }
});
