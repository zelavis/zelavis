import {
  createJsonErrorResponse,
  createMappedJsonErrorResponse,
  type ZelavisServerErrorStatusRule,
} from "@zelavis/server";
import {
  defineService,
  type ZelavisServiceDefinition,
  type ZelavisServiceSetupContext,
} from "zelavis/service";
import { createEcommerce } from "./core/create-ecommerce.js";
import { createDatabaseEcommerceRepositories } from "./repositories/database.js";
import type {
  Coupon,
  Order,
  Product,
} from "./domain/entities.js";
import type { DatabaseApi } from "@zelavis/db";
import type { CreateCouponInput } from "./services/coupon-service.js";
import type { CreateCustomerInput } from "./services/customer-service.js";
import type { CreateOrderInput } from "./services/order-service.js";
import type { CreateProductInput } from "./services/product-service.js";
import type { EcommerceService } from "./ecommerce-service.js";

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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function createServiceDocumentPage(options: {
  title: string;
  eyebrow: string;
  description: string;
  sections: readonly { title: string; detail: string }[];
}) {
  const escapedTitle = escapeHtml(options.title);
  const escapedEyebrow = escapeHtml(options.eyebrow);
  const escapedDescription = escapeHtml(options.description);
  const sections = options.sections
    .map(
      (section) => `
        <article class="card">
          <h2>${escapeHtml(section.title)}</h2>
          <p>${escapeHtml(section.detail)}</p>
        </article>
      `,
    )
    .join("");

  return {
    html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapedTitle}</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #ffffff;
        --fg: #111827;
        --muted: #6b7280;
        --border: rgba(15, 23, 42, 0.12);
        --panel: rgba(15, 23, 42, 0.03);
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #0b1220;
          --fg: #f8fafc;
          --muted: #94a3b8;
          --border: rgba(148, 163, 184, 0.22);
          --panel: rgba(148, 163, 184, 0.08);
        }
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font: 16px/1.55 system-ui, sans-serif;
        background: var(--bg);
        color: var(--fg);
      }
      main {
        width: min(1120px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 28px 0 40px;
      }
      .eyebrow {
        margin: 0 0 8px;
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }
      h1 {
        margin: 0;
        font-size: clamp(2rem, 3vw, 2.8rem);
        line-height: 1.05;
      }
      .description {
        margin: 14px 0 0;
        max-width: 68ch;
        color: var(--muted);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 16px;
        margin-top: 28px;
      }
      .card {
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--panel);
        padding: 16px;
      }
      .card h2 {
        margin: 0 0 8px;
        font-size: 1rem;
      }
      .card p {
        margin: 0;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">${escapedEyebrow}</p>
      <h1>${escapedTitle}</h1>
      <p class="description">${escapedDescription}</p>
      <section class="grid">${sections}</section>
    </main>
  </body>
</html>`,
  };
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

function isEcommercePaymentService(
  service: Readonly<ZelavisServiceDefinition<any>>,
): service is EcommerceService {
  return (
    service.extends === "@zelavis/ecommerce" &&
    typeof service.setup === "function"
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

export const zelavisEcommerceService = defineService<ZelavisServiceSetupContext>({
  name: "@zelavis/ecommerce",
  version: "0.1.0",
  kind: "plugin",
  capabilities: ["api:routes", "dashboard:menu"],
  childServices: ["@zelavis/ecommerce-stripe", "@zelavis/ecommerce-paypal"],
  menu: {
    title: "Ecommerce",
    path: "/commerce",
    pageLabel: "Commerce",
    page: {
      id: "dashboard",
      title: "Commerce",
      render() {
        return createServiceDocumentPage({
          title: "Ecommerce",
          eyebrow: "Commerce",
          description:
            "Service-owned workspace area rendered through a full-document iframe, independent from the host dashboard framework.",
          sections: [
            {
              title: "Catalog",
              detail:
                "Products, prices, and catalog workflows stay inside the service document.",
            },
            {
              title: "Orders",
              detail:
                "Operational screens can use any frontend stack without leaking styles into Zelavis.",
            },
            {
              title: "Providers",
              detail:
                "Payment and shipping services can grow under this service-owned area later.",
            },
          ],
        });
      },
    },
    items: [
      {
        title: "Products",
        path: "/commerce/products",
        page: {
          id: "products",
          title: "Products",
          render() {
            return createServiceDocumentPage({
              title: "Products",
              eyebrow: "Commerce",
              description:
                "A standalone service page can own product tooling, previews, scripts, and styles without React coupling.",
              sections: [
                {
                  title: "Product table",
                  detail:
                    "The service can render its own listing UI, filters, and creation flows.",
                },
                {
                  title: "Design freedom",
                  detail:
                    "This page is a real document, so plain HTML, React, Vue, or web components all stay valid.",
                },
              ],
            });
          },
        },
      },
      {
        title: "Orders",
        path: "/commerce/orders",
        page: {
          id: "orders",
          title: "Orders",
          render() {
            return createServiceDocumentPage({
              title: "Orders",
              eyebrow: "Commerce",
              description:
                "Order workflows can stay completely service-owned while still living inside the Zelavis workspace shell.",
              sections: [
                {
                  title: "Drafts",
                  detail:
                    "Draft creation, fulfillment, and payment tracking can be handled inside the service document.",
                },
                {
                  title: "Isolation",
                  detail:
                    "The iframe boundary prevents CSS and runtime collisions with the host dashboard.",
                },
              ],
            });
          },
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
              render() {
                return createServiceDocumentPage({
                  title: "Customers",
                  eyebrow: "Commerce",
                  description:
                    "Customer records and related workflows can evolve independently from host dashboard internals.",
                  sections: [
                    {
                      title: "Profiles",
                      detail:
                        "Customer profile views, notes, and account linking can be handled in service space.",
                    },
                  ],
                });
              },
            },
          },
          {
            title: "Coupons",
            path: "/commerce/coupons",
            page: {
              id: "coupons",
              title: "Coupons",
              render() {
                return createServiceDocumentPage({
                  title: "Coupons",
                  eyebrow: "Commerce",
                  description:
                    "Promotions and rule editors can ship as a standalone document without needing shared dashboard CSS classes.",
                  sections: [
                    {
                      title: "Discount rules",
                      detail:
                        "Coupon editors, previews, and validation UI all stay fully service-owned.",
                    },
                  ],
                });
              },
            },
          },
        ],
      },
    ],
  },
  async setup(context) {
    const paymentServices = context.children.filter(
      isEcommercePaymentService,
    ) as readonly EcommerceService[];
    const commerce = await createEcommerce({
      services: paymentServices,
      repositories: isDatabaseApi(context.core.database)
        ? createDatabaseEcommerceRepositories(context.core.database)
        : undefined,
    });

    return {
      runtimeServices: [
        {
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
                    providers: service.payments.listProviders().map((name: string) => {
                      const childService = service.context.childServices.find(
                        (service: { name: string; extends?: string }) => service.name === name,
                      );

                      return {
                        name,
                        parentService: childService?.extends ?? "@zelavis/ecommerce",
                        childService: true,
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
        },
      ],
    };
  },
});

export default zelavisEcommerceService;
