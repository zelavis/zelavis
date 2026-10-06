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
