import { createEcommerce } from "@zelavis/ecommerce";
import { paypalPlugin } from "@zelavis/ecommerce-paypal";
import { stripePlugin } from "@zelavis/ecommerce-stripe";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

async function main(): Promise<void> {
  const commerce = await createEcommerce({
    plugins: [
      stripePlugin({
        secretKey: requiredEnv("STRIPE_SECRET_KEY"),
      }),
      paypalPlugin({
        clientId: requiredEnv("PAYPAL_CLIENT_ID"),
        clientSecret: requiredEnv("PAYPAL_CLIENT_SECRET"),
        environment: "sandbox",
      }),
    ],
  });

  const customer = await commerce.customers.create({
    id: "cus_demo_1",
    accountId: "acc_demo_1",
    email: "ada@example.com",
    firstName: "Ada",
    lastName: "Lovelace",
  });

  const stripeSubscription = await commerce.payments.createSubscription(
    {
      customerId: customer.id,
      amount: 1999,
      currency: "USD",
      interval: "month",
      intervalCount: 1,
      providerCustomerReference: "cus_stripe_123",
      providerPlanReference: "price_123",
      referenceId: "sub_ref_stripe_demo",
      metadata: {
        source: "docs/ecommerce-recurring-subscriptions.ts",
      },
    },
    "stripe",
  );

  const paypalSubscription = await commerce.payments.createSubscription(
    {
      customerId: customer.id,
      amount: 1999,
      currency: "USD",
      interval: "month",
      intervalCount: 1,
      providerPlanReference: "P-123",
      referenceId: "sub_ref_paypal_demo",
      metadata: {
        source: "docs/ecommerce-recurring-subscriptions.ts",
      },
    },
    "paypal",
  );

  const activeSubscriptions = await commerce.payments.listSubscriptions();
  console.log("active subscriptions", activeSubscriptions);

  const cancelledStripe = await commerce.payments.cancelSubscription(
    stripeSubscription.id,
  );
  console.log("cancelled stripe subscription", cancelledStripe);

  const cancelledPayPal = await commerce.payments.cancelSubscription(
    paypalSubscription.id,
  );
  console.log("cancelled paypal subscription", cancelledPayPal);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
