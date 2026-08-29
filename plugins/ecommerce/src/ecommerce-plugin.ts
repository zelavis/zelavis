import {
  createJsonErrorResponse,
  createMappedJsonErrorResponse,
  type ZelavisServerErrorStatusRule,
  type ZelavisServerRoute,
} from "zelavis/core";
import type { ZelavisServiceSetupContext } from "zelavis/service";
import { createEcommerce } from "./core/create-ecommerce.js";
import { createDatabaseEcommerceRepositories } from "./repositories/database.js";
import type {
  Coupon,
  Order,
  Product,
  SubscriptionInterval,
} from "./domain/entities.js";
import type { DatabaseApi } from "zelavis/app/db";
import type { CreateSubscriptionInput } from "./contracts/payment-provider.js";
import type { CreateCouponInput } from "./services/coupon-service.js";
import type { CreateCustomerInput } from "./services/customer-service.js";
import type { CreateOrderInput } from "./services/order-service.js";
import type { CreateProductInput } from "./services/product-service.js";
import type { EcommerceService } from "./ecommerce-service.js";
import type { EcommerceApi } from "./core/types.js";

const commerceErrorRules: readonly ZelavisServerErrorStatusRule[] = [
  {
    matches: (error) => error instanceof TypeError,
    status: 400,
  },
];

function readBodyObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new TypeError("Request body must be a JSON object.");
  }

  return body as Record<string, unknown>;
}

function readOptionalString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];

  if (value == null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new TypeError(`${key} must be a string.`);
  }

  return value;
}

function readRequiredString(
  input: Record<string, unknown>,
  key: string,
): string {
  const value = readOptionalString(input, key);

  if (!value) {
    throw new TypeError(`${key} is required.`);
  }

  return value;
}

function readOptionalBoolean(
  input: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = input[key];

  if (value == null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new TypeError(`${key} must be a boolean.`);
  }

  return value;
}

function readOptionalNumber(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];

  if (value == null) {
    return undefined;
  }

  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new TypeError(`${key} must be a number.`);
  }

  return value;
}

function readRequiredNumber(
  input: Record<string, unknown>,
  key: string,
): number {
  const value = readOptionalNumber(input, key);

  if (value == null) {
    throw new TypeError(`${key} is required.`);
  }

  return value;
}

function readOptionalObject(
  input: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = input[key];

  if (value == null) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${key} must be a JSON object.`);
  }

  return value as Record<string, unknown>;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function createCommerceErrorResponse(error: unknown, fallback = 400) {
  return createMappedJsonErrorResponse(error, commerceErrorRules, fallback);
}

function createNotFoundResponse(label: string, value: string) {
  return createJsonErrorResponse(404, new Error(`${label} ${value} was not found.`));
}

function isDatabaseApi(value: unknown): value is DatabaseApi {
  return Boolean(
    value &&
      typeof value === "object" &&
      "forTenant" in value &&
      "schemas" in value &&
      "capabilities" in value,
  );
}

function isEcommercePaymentService(
  service: Readonly<{ capabilities?: readonly string[]; service?: unknown }>,
): boolean {
  return (
    service.capabilities?.includes("provider:payments") === true &&
    typeof (service.service as EcommerceService | undefined)?.register === "function"
  );
}

function parseProductInput(body: unknown): CreateProductInput {
  const input = readBodyObject(body);
  const title = readRequiredString(input, "title");
  const price = readOptionalObject(input, "price");

  if (!price) {
    throw new TypeError("price is required.");
  }

  const amount = price.amount;
  const currency = price.currency;

  if (typeof amount !== "number" || Number.isNaN(amount)) {
    throw new TypeError("price.amount must be a number.");
  }

  if (typeof currency !== "string" || !currency) {
    throw new TypeError("price.currency must be a string.");
  }

  const id = readOptionalString(input, "id") ?? crypto.randomUUID();
  const generatedSlug = slugify(title);
  const slug =
    readOptionalString(input, "slug") ?? (generatedSlug.length > 0 ? generatedSlug : id);

  return {
    id,
    slug,
    title,
    description: readOptionalString(input, "description"),
    price: {
      amount,
      currency,
    } satisfies Product["price"],
    metadata: readOptionalObject(input, "metadata"),
  };
}

function parseCustomerInput(body: unknown): CreateCustomerInput {
  const input = readBodyObject(body);

  return {
    id: readOptionalString(input, "id") ?? crypto.randomUUID(),
    accountId: readOptionalString(input, "accountId"),
    email: readRequiredString(input, "email"),
    firstName: readOptionalString(input, "firstName"),
    lastName: readOptionalString(input, "lastName"),
    metadata: readOptionalObject(input, "metadata"),
  };
}

function parseCouponInput(body: unknown): CreateCouponInput {
  const input = readBodyObject(body);
  const discountType = readRequiredString(input, "discountType");
  const discountValue = input.discountValue;

  if (discountType !== "percentage" && discountType !== "fixed") {
    throw new TypeError("discountType must be 'percentage' or 'fixed'.");
  }

  if (typeof discountValue !== "number" || Number.isNaN(discountValue)) {
    throw new TypeError("discountValue must be a number.");
  }

  const normalizedDiscountType: Coupon["discountType"] = discountType;

  return {
    code: readRequiredString(input, "code"),
    description: readOptionalString(input, "description"),
    discountType: normalizedDiscountType,
    discountValue,
    active: readOptionalBoolean(input, "active"),
    metadata: readOptionalObject(input, "metadata"),
  };
}

function parseOrderInput(body: unknown): CreateOrderInput {
  const input = readBodyObject(body);
  const items = input.items;
  const totals = input.totals;
  const couponCodes = input.couponCodes;

  if (!Array.isArray(items)) {
    throw new TypeError("items must be an array.");
  }

  const normalizedItems: Order["items"] = items.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`items[${index}] must be a JSON object.`);
    }

    const productId = (item as Record<string, unknown>).productId;
    const quantity = (item as Record<string, unknown>).quantity;
    const unitPrice = (item as Record<string, unknown>).unitPrice;

    if (typeof productId !== "string" || !productId) {
      throw new TypeError(`items[${index}].productId must be a string.`);
    }

    if (typeof quantity !== "number" || Number.isNaN(quantity)) {
      throw new TypeError(`items[${index}].quantity must be a number.`);
    }

    if (typeof unitPrice !== "number" || Number.isNaN(unitPrice)) {
      throw new TypeError(`items[${index}].unitPrice must be a number.`);
    }

    return {
      productId,
      quantity,
      unitPrice,
    };
  });

  if (!totals || typeof totals !== "object" || Array.isArray(totals)) {
    throw new TypeError("totals must be a JSON object.");
  }

  const subtotal = (totals as Record<string, unknown>).subtotal;
  const discountTotal = (totals as Record<string, unknown>).discountTotal;
  const taxTotal = (totals as Record<string, unknown>).taxTotal;
  const grandTotal = (totals as Record<string, unknown>).grandTotal;
  const currency = (totals as Record<string, unknown>).currency;

  for (const [key, value] of [
    ["subtotal", subtotal],
    ["discountTotal", discountTotal],
    ["taxTotal", taxTotal],
    ["grandTotal", grandTotal],
  ] as const) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      throw new TypeError(`totals.${key} must be a number.`);
    }
  }

  if (typeof currency !== "string" || !currency) {
    throw new TypeError("totals.currency must be a string.");
  }

  const normalizedSubtotal = subtotal as number;
  const normalizedDiscountTotal = discountTotal as number;
  const normalizedTaxTotal = taxTotal as number;
  const normalizedGrandTotal = grandTotal as number;

  if (couponCodes != null && !Array.isArray(couponCodes)) {
    throw new TypeError("couponCodes must be an array.");
  }

  return {
    id: readOptionalString(input, "id") ?? crypto.randomUUID(),
    customerId: readRequiredString(input, "customerId"),
    items: normalizedItems,
    couponCodes:
      (couponCodes as string[] | undefined)?.map((code, index) => {
        if (typeof code !== "string" || !code) {
          throw new TypeError(`couponCodes[${index}] must be a string.`);
        }

        return code;
      }) ?? [],
    totals: {
      subtotal: normalizedSubtotal,
      discountTotal: normalizedDiscountTotal,
      taxTotal: normalizedTaxTotal,
      grandTotal: normalizedGrandTotal,
      currency,
    },
    metadata: readOptionalObject(input, "metadata"),
  };
}

/**
 * Parses subscription creation input.
 *
 * Captures recurring billing parameters learned from subscription prototyping:
 * - customerId: Local customer ID
 * - provider: Target payment provider ("stripe", "paypal", etc.)
 * - amount & currency: Recurring charge magnitude
 * - interval & intervalCount: Recurring cadence (day, week, month, year)
 * - trialPeriodDays: Deferred first bill date
 * - providerPlanReference: Existing gateway price/plan (e.g. price_123 or P-123)
 * - providerCustomerReference: Existing gateway customer (e.g. cus_123)
 * - referenceId: Idempotency & tracking token
 */
function parseSubscriptionCreation(body: unknown): {
  input: CreateSubscriptionInput;
  provider: string;
} {
  const raw = readBodyObject(body);
  const customerId = readRequiredString(raw, "customerId");
  const provider = readRequiredString(raw, "provider");
  const amount = readRequiredNumber(raw, "amount");
  const currency = readRequiredString(raw, "currency");
  const rawInterval = readRequiredString(raw, "interval").toLowerCase();

  if (
    rawInterval !== "day" &&
    rawInterval !== "week" &&
    rawInterval !== "month" &&
    rawInterval !== "year"
  ) {
    throw new TypeError("interval must be 'day', 'week', 'month', or 'year'.");
  }

  const interval: SubscriptionInterval = rawInterval;
  const intervalCount = readOptionalNumber(raw, "intervalCount");
  const trialPeriodDays = readOptionalNumber(raw, "trialPeriodDays");
  const referenceId = readOptionalString(raw, "referenceId");
  const providerCustomerReference = readOptionalString(raw, "providerCustomerReference");
  const providerPlanReference = readOptionalString(raw, "providerPlanReference");
  const providerProductReference = readOptionalString(raw, "providerProductReference");
  const metadata = readOptionalObject(raw, "metadata");

  return {
    provider,
    input: {
      customerId,
      amount,
      currency,
      interval,
      intervalCount: intervalCount ?? 1,
      trialPeriodDays,
      referenceId,
      providerCustomerReference,
      providerPlanReference,
      providerProductReference,
      metadata,
    },
  };
}

/**
 * Official Zelavis Ecommerce Plugin
 *
 * Implements the standard Zelavis plugin definition contract (kind: "plugin")
 * providing products, customers, coupons, orders, and payment/subscription lifecycle management.
 *
 * Payment gateways (Stripe, PayPal, etc.) are discovered dynamically through
 * the `provider:payments` capability from installed services, avoiding hardcoded plugin allow-lists.
 */
export const ecommercePlugin = Object.freeze({
  name: "@zelavis/ecommerce",
  version: "1.0.1-alpha.2",
  kind: "plugin",
  capabilities: Object.freeze(["api:routes", "dashboard:menu"]),
  menu: {
    title: "Ecommerce",
    path: "/commerce",
    pageLabel: "Commerce",
    page: {
      id: "dashboard",
      title: "Commerce",
      bundle: "dashboard",
      file: "dashboard.html",
    },
    items: [
      {
        title: "Products",
        path: "/commerce/products",
        page: {
          id: "products",
          title: "Products",
          bundle: "dashboard",
          file: "products.html",
        },
      },
      {
        title: "Orders",
        path: "/commerce/orders",
        page: {
          id: "orders",
          title: "Orders",
          bundle: "dashboard",
          file: "orders.html",
        },
      },
      {
        title: "More",
        items: [
          {
            title: "Customers",
            path: "/commerce/customers",
            page: {
              id: "customers",
              title: "Customers",
              bundle: "dashboard",
              file: "customers.html",
            },
          },
          {
            title: "Coupons",
            path: "/commerce/coupons",
            page: {
              id: "coupons",
              title: "Coupons",
              bundle: "dashboard",
              file: "coupons.html",
            },
          },
        ],
      },
    ],
  },
  async setup(context: ZelavisServiceSetupContext) {
    // Dynamic provider discovery: discover payment providers by declared capability
    const paymentServices = context.registry
      .filter((entry) => entry.status === "installed" && isEcommercePaymentService(entry.service))
      .map((entry) => entry.service.service as EcommerceService);

    const commerce = await createEcommerce({
      services: paymentServices,
      repositories: isDatabaseApi(context.core.database)
        ? createDatabaseEcommerceRepositories(context.core.database, {
            tenantId: `service:${context.service.name}`,
          })
        : undefined,
    });

    const routes: readonly ZelavisServerRoute<EcommerceApi>[] = [
          {
            id: "commerce.health",
            method: "GET",
            path: "/health",
            spec: {
              operationId: "getCommerceHealth",
              summary: "Health and runtime status of ecommerce service",
              tags: ["commerce"],
              responses: {
                200: { description: "Service health information" },
              },
            },
            handler: () => ({
              status: 200,
              body: {
                service: context.service.name,
                rootPath: context.rootPath,
                apiBasePath: context.api.basePath,
                platform: {
                  presets: context.platform.presets,
                  resources: context.platform.resources,
                },
              },
            }),
          },
          {
            id: "commerce.products.list",
            method: "GET",
            path: "/products",
            spec: {
              operationId: "listProducts",
              summary: "List all products",
              tags: ["commerce", "products"],
              responses: {
                200: { description: "List of products" },
              },
            },
            handler: async ({ service }) => ({
              status: 200,
              body: await service.products.list(),
            }),
          },
          {
            id: "commerce.products.create",
            method: "POST",
            path: "/products",
            spec: {
              operationId: "createProduct",
              summary: "Create a new product",
              tags: ["commerce", "products"],
              requestBody: {
                required: true,
                schema: {
                  type: "object",
                  required: ["title", "price"],
                  properties: {
                    id: { type: "string" },
                    title: { type: "string" },
                    slug: { type: "string" },
                    description: { type: "string" },
                    price: {
                      type: "object",
                      required: ["amount", "currency"],
                      properties: {
                        amount: { type: "number" },
                        currency: { type: "string" },
                      },
                    },
                    metadata: { type: "object" },
                  },
                },
              },
              responses: {
                201: { description: "Product created" },
                400: { description: "Bad request" },
              },
            },
            handler: async ({ service, body }) => {
              try {
                return {
                  status: 201,
                  body: await service.products.create(parseProductInput(body)),
                };
              } catch (error) {
                return createCommerceErrorResponse(error, 400);
              }
            },
          },
          {
            id: "commerce.products.getById",
            method: "GET",
            path: "/products/:id",
            spec: {
              operationId: "getProductById",
              summary: "Get a product by ID",
              tags: ["commerce", "products"],
              responses: {
                200: { description: "Product details" },
                404: { description: "Product not found" },
              },
            },
            handler: async ({ service, params }) => {
              const product = await service.products.getById(params.id);

              if (!product) {
                return createNotFoundResponse("Product", params.id);
              }

              return {
                status: 200,
                body: product,
              };
            },
          },
          {
            id: "commerce.customers.list",
            method: "GET",
            path: "/customers",
            spec: {
              operationId: "listCustomers",
              summary: "List customers",
              tags: ["commerce", "customers"],
              responses: {
                200: { description: "List of customers" },
              },
            },
            handler: async ({ service }) => ({
              status: 200,
              body: await service.customers.list(),
            }),
          },
          {
            id: "commerce.customers.create",
            method: "POST",
            path: "/customers",
            spec: {
              operationId: "createCustomer",
              summary: "Create a customer record",
              tags: ["commerce", "customers"],
              requestBody: {
                required: true,
                schema: {
                  type: "object",
                  required: ["email"],
                  properties: {
                    id: { type: "string" },
                    email: { type: "string" },
                    accountId: { type: "string" },
                    firstName: { type: "string" },
                    lastName: { type: "string" },
                    metadata: { type: "object" },
                  },
                },
              },
              responses: {
                201: { description: "Customer created" },
                400: { description: "Bad request" },
              },
            },
            handler: async ({ service, body }) => {
              try {
                return {
                  status: 201,
                  body: await service.customers.create(parseCustomerInput(body)),
                };
              } catch (error) {
                return createCommerceErrorResponse(error, 400);
              }
            },
          },
          {
            id: "commerce.customers.getById",
            method: "GET",
            path: "/customers/:id",
            spec: {
              operationId: "getCustomerById",
              summary: "Get a customer by ID",
              tags: ["commerce", "customers"],
              responses: {
                200: { description: "Customer details" },
                404: { description: "Customer not found" },
              },
            },
            handler: async ({ service, params }) => {
              const customer = await service.customers.getById(params.id);

              if (!customer) {
                return createNotFoundResponse("Customer", params.id);
              }

              return {
                status: 200,
                body: customer,
              };
            },
          },
          {
            id: "commerce.coupons.list",
            method: "GET",
            path: "/coupons",
            spec: {
              operationId: "listCoupons",
              summary: "List discount coupons",
              tags: ["commerce", "coupons"],
              responses: {
                200: { description: "List of coupons" },
              },
            },
            handler: async ({ service }) => ({
              status: 200,
              body: await service.coupons.list(),
            }),
          },
          {
            id: "commerce.coupons.create",
            method: "POST",
            path: "/coupons",
            spec: {
              operationId: "createCoupon",
              summary: "Create a discount coupon",
              tags: ["commerce", "coupons"],
              requestBody: {
                required: true,
                schema: {
                  type: "object",
                  required: ["code", "discountType", "discountValue"],
                  properties: {
                    code: { type: "string" },
                    description: { type: "string" },
                    discountType: { type: "string", enum: ["percentage", "fixed"] },
                    discountValue: { type: "number" },
                    active: { type: "boolean" },
                    metadata: { type: "object" },
                  },
                },
              },
              responses: {
                201: { description: "Coupon created" },
                400: { description: "Bad request" },
              },
            },
            handler: async ({ service, body }) => {
              try {
                return {
                  status: 201,
                  body: await service.coupons.create(parseCouponInput(body)),
                };
              } catch (error) {
                return createCommerceErrorResponse(error, 400);
              }
            },
          },
          {
            id: "commerce.coupons.getByCode",
            method: "GET",
            path: "/coupons/:code",
            spec: {
              operationId: "getCouponByCode",
              summary: "Get a coupon by code",
              tags: ["commerce", "coupons"],
              responses: {
                200: { description: "Coupon details" },
                404: { description: "Coupon not found" },
              },
            },
            handler: async ({ service, params }) => {
              const coupon = await service.coupons.getByCode(params.code);

              if (!coupon) {
                return createNotFoundResponse("Coupon", params.code);
              }

              return {
                status: 200,
                body: coupon,
              };
            },
          },
          {
            id: "commerce.orders.list",
            method: "GET",
            path: "/orders",
            spec: {
              operationId: "listOrders",
              summary: "List orders",
              tags: ["commerce", "orders"],
              responses: {
                200: { description: "List of orders" },
              },
            },
            handler: async ({ service }) => ({
              status: 200,
              body: await service.orders.list(),
            }),
          },
          {
            id: "commerce.orders.create",
            method: "POST",
            path: "/orders",
            spec: {
              operationId: "createOrder",
              summary: "Create an order",
              tags: ["commerce", "orders"],
              requestBody: {
                required: true,
                schema: {
                  type: "object",
                  required: ["customerId", "items", "totals"],
                  properties: {
                    id: { type: "string" },
                    customerId: { type: "string" },
                    items: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["productId", "quantity", "unitPrice"],
                        properties: {
                          productId: { type: "string" },
                          quantity: { type: "number" },
                          unitPrice: { type: "number" },
                        },
                      },
                    },
                    couponCodes: { type: "array", items: { type: "string" } },
                    totals: {
                      type: "object",
                      required: ["subtotal", "discountTotal", "taxTotal", "grandTotal", "currency"],
                      properties: {
                        subtotal: { type: "number" },
                        discountTotal: { type: "number" },
                        taxTotal: { type: "number" },
                        grandTotal: { type: "number" },
                        currency: { type: "string" },
                      },
                    },
                    metadata: { type: "object" },
                  },
                },
              },
              responses: {
                201: { description: "Order created" },
                400: { description: "Bad request" },
              },
            },
            handler: async ({ service, body }) => {
              try {
                return {
                  status: 201,
                  body: await service.orders.create(parseOrderInput(body)),
                };
              } catch (error) {
                return createCommerceErrorResponse(error, 400);
              }
            },
          },
          {
            id: "commerce.orders.getById",
            method: "GET",
            path: "/orders/:id",
            spec: {
              operationId: "getOrderById",
              summary: "Get an order by ID",
              tags: ["commerce", "orders"],
              responses: {
                200: { description: "Order details" },
                404: { description: "Order not found" },
              },
            },
            handler: async ({ service, params }) => {
              const order = await service.orders.getById(params.id);

              if (!order) {
                return createNotFoundResponse("Order", params.id);
              }

              return {
                status: 200,
                body: order,
              };
            },
          },
          {
            id: "commerce.payments.providers.list",
            method: "GET",
            path: "/payments/providers",
            spec: {
              operationId: "listPaymentProviders",
              summary: "List installed payment providers",
              tags: ["commerce", "payments"],
              responses: {
                200: { description: "List of payment providers" },
              },
            },
            handler: ({ service }) => ({
              status: 200,
              body: {
                providers: service.payments.listProviders().map((name: string) => {
                  return {
                    name,
                    plugin: service.context.providers.find(
                      (provider: { name: string }) => provider.name === name,
                    )?.name,
                  };
                }),
              },
            }),
          },
          {
            id: "commerce.payments.attempts.list",
            method: "GET",
            path: "/payments/attempts",
            spec: {
              operationId: "listPaymentAttempts",
              summary: "List payment attempts",
              tags: ["commerce", "payments"],
              responses: {
                200: { description: "List of payment attempts" },
              },
            },
            handler: async ({ service }) => ({
              status: 200,
              body: await service.payments.listPaymentAttempts(),
            }),
          },
          {
            id: "commerce.payments.create",
            method: "POST",
            path: "/orders/:id/payments",
            spec: {
              operationId: "createOrderPayment",
              summary: "Initiate payment for an order",
              tags: ["commerce", "payments"],
              requestBody: {
                required: true,
                schema: {
                  type: "object",
                  required: ["provider"],
                  properties: {
                    provider: { type: "string" },
                  },
                },
              },
              responses: {
                201: { description: "Payment attempt initiated" },
                400: { description: "Bad request" },
                404: { description: "Order not found" },
              },
            },
            handler: async ({ service, params, body }) => {
              const order = await service.orders.getById(params.id);

              if (!order) {
                return createNotFoundResponse("Order", params.id);
              }

              try {
                const input = readBodyObject(body);
                const provider = readRequiredString(input, "provider");

                return {
                  status: 201,
                  body: await service.payments.createPayment(order, provider),
                };
              } catch (error) {
                return createCommerceErrorResponse(error, 400);
              }
            },
          },
          {
            id: "commerce.subscriptions.list",
            method: "GET",
            path: "/subscriptions",
            spec: {
              operationId: "listSubscriptions",
              summary: "List recurring billing subscriptions",
              tags: ["commerce", "subscriptions"],
              responses: {
                200: { description: "List of active and historical subscriptions" },
              },
            },
            handler: async ({ service }) => ({
              status: 200,
              body: await service.payments.listSubscriptions(),
            }),
          },
          {
            id: "commerce.subscriptions.create",
            method: "POST",
            path: "/subscriptions",
            spec: {
              operationId: "createSubscription",
              summary: "Create a recurring billing subscription",
              tags: ["commerce", "subscriptions"],
              requestBody: {
                required: true,
                schema: {
                  type: "object",
                  required: ["customerId", "provider", "amount", "currency", "interval"],
                  properties: {
                    customerId: { type: "string", description: "Zelavis Customer ID" },
                    provider: { type: "string", description: "Payment provider ('stripe', 'paypal')" },
                    amount: { type: "number", description: "Amount in minor units or base units depending on currency" },
                    currency: { type: "string", description: "Currency code (e.g. USD, EUR)" },
                    interval: { type: "string", enum: ["day", "week", "month", "year"] },
                    intervalCount: { type: "number", default: 1 },
                    trialPeriodDays: { type: "number" },
                    providerCustomerReference: { type: "string" },
                    providerPlanReference: { type: "string" },
                    providerProductReference: { type: "string" },
                    referenceId: { type: "string" },
                    metadata: { type: "object" },
                  },
                },
              },
              responses: {
                201: { description: "Subscription created" },
                400: { description: "Bad request" },
              },
            },
            handler: async ({ service, body }) => {
              try {
                const { input, provider } = parseSubscriptionCreation(body);
                const subscription = await service.payments.createSubscription(input, provider);
                return {
                  status: 201,
                  body: subscription,
                };
              } catch (error) {
                return createCommerceErrorResponse(error, 400);
              }
            },
          },
          {
            id: "commerce.subscriptions.getById",
            method: "GET",
            path: "/subscriptions/:id",
            spec: {
              operationId: "getSubscriptionById",
              summary: "Get subscription details by ID",
              tags: ["commerce", "subscriptions"],
              responses: {
                200: { description: "Subscription details" },
                404: { description: "Subscription not found" },
              },
            },
            handler: async ({ service, params }) => {
              const subscription = await service.payments.getSubscriptionById(params.id);

              if (!subscription) {
                return createNotFoundResponse("Subscription", params.id);
              }

              return {
                status: 200,
                body: subscription,
              };
            },
          },
          {
            id: "commerce.subscriptions.cancel",
            method: "POST",
            path: "/subscriptions/:id/cancel",
            spec: {
              operationId: "cancelSubscription",
              summary: "Cancel an active subscription",
              tags: ["commerce", "subscriptions"],
              requestBody: {
                required: false,
                schema: {
                  type: "object",
                  properties: {
                    providerName: { type: "string" },
                    metadata: { type: "object" },
                  },
                },
              },
              responses: {
                200: { description: "Subscription cancelled" },
                400: { description: "Bad request" },
                404: { description: "Subscription not found" },
              },
            },
            handler: async ({ service, params, body }) => {
              try {
                const options = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
                const providerName = readOptionalString(options, "providerName");
                const metadata = readOptionalObject(options, "metadata");

                const cancelled = await service.payments.cancelSubscription(params.id, {
                  providerName,
                  metadata,
                });

                return {
                  status: 200,
                  body: cancelled,
                };
              } catch (error) {
                return createCommerceErrorResponse(error, 400);
              }
            },
          },
    ];

    context.addService({
      name: "commerce",
      basePath: "/commerce",
      service: commerce,
      api: {
        v1: routes,
      },
    });
  },
});

export default ecommercePlugin;
