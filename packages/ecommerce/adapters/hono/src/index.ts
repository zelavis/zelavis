import type { EcommerceApi } from "@zelavis/ecommerce";
import type { Hono } from "hono";

export interface HonoEcommerceRoutesOptions {
  basePath?: string;
}

function normalizeBasePath(basePath = "/ecommerce"): string {
  return basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
}

function errorBody(error: unknown): { error: string } {
  return {
    error: error instanceof Error ? error.message : "Unknown error",
  };
}

export function registerHonoEcommerceRoutes(
  app: Hono,
  commerce: EcommerceApi,
  options: HonoEcommerceRoutesOptions = {},
): Hono {
  const basePath = normalizeBasePath(options.basePath);

  app.get(`${basePath}/customers`, async (context) => {
    return context.json(await commerce.customers.list());
  });

  app.post(`${basePath}/customers`, async (context) => {
    try {
      return context.json(await commerce.customers.create(await context.req.json()), 201);
    } catch (error) {
      return context.json(errorBody(error), 400);
    }
  });

  app.get(`${basePath}/products`, async (context) => {
    return context.json(await commerce.products.list());
  });

  app.post(`${basePath}/products`, async (context) => {
    try {
      return context.json(await commerce.products.create(await context.req.json()), 201);
    } catch (error) {
      return context.json(errorBody(error), 400);
    }
  });

  app.get(`${basePath}/coupons`, async (context) => {
    return context.json(await commerce.coupons.list());
  });

  app.post(`${basePath}/coupons`, async (context) => {
    try {
      return context.json(await commerce.coupons.create(await context.req.json()), 201);
    } catch (error) {
      return context.json(errorBody(error), 400);
    }
  });

  app.get(`${basePath}/orders`, async (context) => {
    return context.json(await commerce.orders.list());
  });

  app.post(`${basePath}/orders`, async (context) => {
    try {
      return context.json(await commerce.orders.create(await context.req.json()), 201);
    } catch (error) {
      return context.json(errorBody(error), 400);
    }
  });

  app.post(`${basePath}/orders/:orderId/payments`, async (context) => {
    try {
      const order = await commerce.orders.getById(context.req.param("orderId"));

      if (!order) {
        return context.json({ error: "Order not found." }, 404);
      }

      const body = (await context.req.json()) as { provider: string };
      return context.json(await commerce.payments.createPayment(order, body.provider), 201);
    } catch (error) {
      return context.json(errorBody(error), 400);
    }
  });

  return app;
}
