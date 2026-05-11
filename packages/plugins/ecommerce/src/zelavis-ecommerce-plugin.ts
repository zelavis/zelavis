import {
  createJsonErrorResponse,
  createMappedJsonErrorResponse,
  defineService,
  type ZelavisServerErrorStatusRule,
} from "@zelavis/server";
import {
  definePlugin,
  type ZelavisPluginSetupContext,
} from "zelavis/plugin";
import { createEcommerce } from "./core/create-ecommerce.js";
import { createDatabaseEcommerceRepositories } from "./repositories/database.js";
import type {
  Coupon,
  Order,
  Product,
} from "./domain/entities.js";
import type { DatabaseApi } from "@zelavis/database";
import type { CreateCouponInput } from "./services/coupon-service.js";
import type { CreateCustomerInput } from "./services/customer-service.js";
import type { CreateOrderInput } from "./services/order-service.js";
import type { CreateProductInput } from "./services/product-service.js";

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
      "documents" in value &&
      "schemas" in value &&
      "events" in value,
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

export const zelavisEcommercePlugin = definePlugin<ZelavisPluginSetupContext>({
  name: "zelavis-ecommerce",
  version: "0.1.0",
  menu: {
    title: "Ecommerce",
    path: "/commerce",
    pageLabel: "Commerce",
    items: [
      {
        title: "Products",
        path: "/commerce/products",
      },
      {
        title: "Orders",
        path: "/commerce/orders",
      },
      {
        title: "More",
        items: [
          {
            title: "Customers",
            path: "/commerce/customers",
          },
          {
            title: "Coupons",
            path: "/commerce/coupons",
          },
        ],
      },
    ],
  },
  async setup(context) {
    const commerce = await createEcommerce({
      repositories: isDatabaseApi(context.core.database)
        ? createDatabaseEcommerceRepositories(context.core.database)
        : undefined,
    });

    return {
      services: [
        defineService({
          name: "commerce",
          basePath: "/commerce",
          service: commerce,
          api: {
            v1: [
              {
                id: "commerce.health",
                method: "GET",
                path: "/health",
                handler: () => ({
                  status: 200,
                  body: {
                    plugin: context.plugin.name,
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
                handler: async ({ service }) => ({
                  status: 200,
                  body: await service.products.list(),
                }),
              },
              {
                id: "commerce.products.create",
                method: "POST",
                path: "/products",
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
                handler: async ({ service }) => ({
                  status: 200,
                  body: await service.customers.list(),
                }),
              },
              {
                id: "commerce.customers.create",
                method: "POST",
                path: "/customers",
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
                handler: async ({ service }) => ({
                  status: 200,
                  body: await service.coupons.list(),
                }),
              },
              {
                id: "commerce.coupons.create",
                method: "POST",
                path: "/coupons",
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
                handler: async ({ service }) => ({
                  status: 200,
                  body: await service.orders.list(),
                }),
              },
              {
                id: "commerce.orders.create",
                method: "POST",
                path: "/orders",
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
                handler: ({ service }) => ({
                  status: 200,
                  body: {
                    providers: service.payments.listProviders().map((name) => {
                      const childPlugin = service.context.childPlugins.find(
                        (plugin) => plugin.name === name,
                      );

                      return {
                        name,
                        extensionPoint: childPlugin?.extensionPoint ?? "payments",
                        targetPlugin: childPlugin?.targetPlugin ?? "zelavis-ecommerce",
                        childPlugin: childPlugin?.childPlugin ?? true,
                      };
                    }),
                  },
                }),
              },
              {
                id: "commerce.payments.attempts.list",
                method: "GET",
                path: "/payments/attempts",
                handler: async ({ service }) => ({
                  status: 200,
                  body: await service.payments.listPaymentAttempts(),
                }),
              },
              {
                id: "commerce.payments.create",
                method: "POST",
                path: "/orders/:id/payments",
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
                handler: async ({ service }) => ({
                  status: 200,
                  body: await service.payments.listSubscriptions(),
                }),
              },
            ],
          },
        }),
      ],
    };
  },
});

export const plugin = zelavisEcommercePlugin;
export default zelavisEcommercePlugin;
