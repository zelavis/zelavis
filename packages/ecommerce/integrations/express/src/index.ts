import type { EcommerceApi } from "@zelavis/ecommerce";
import type { Request, Response, Router } from "express";

export interface ExpressEcommerceRoutesOptions {
  basePath?: string;
}

function normalizeBasePath(basePath = "/ecommerce"): string {
  return basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
}

function sendError(response: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown error";
  response.status(400).json({ error: message });
}

async function parsePaymentBody(request: Request): Promise<{ provider: string }> {
  return request.body as { provider: string };
}

export function registerExpressEcommerceRoutes(
  router: Router,
  commerce: EcommerceApi,
  options: ExpressEcommerceRoutesOptions = {},
): Router {
  const basePath = normalizeBasePath(options.basePath);

  router.get(`${basePath}/customers`, async (_request, response) => {
    response.json(await commerce.customers.list());
  });

  router.post(`${basePath}/customers`, async (request, response) => {
    try {
      response.status(201).json(await commerce.customers.create(request.body));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get(`${basePath}/products`, async (_request, response) => {
    response.json(await commerce.products.list());
  });

  router.post(`${basePath}/products`, async (request, response) => {
    try {
      response.status(201).json(await commerce.products.create(request.body));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get(`${basePath}/coupons`, async (_request, response) => {
    response.json(await commerce.coupons.list());
  });

  router.post(`${basePath}/coupons`, async (request, response) => {
    try {
      response.status(201).json(await commerce.coupons.create(request.body));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get(`${basePath}/orders`, async (_request, response) => {
    response.json(await commerce.orders.list());
  });

  router.post(`${basePath}/orders`, async (request, response) => {
    try {
      response.status(201).json(await commerce.orders.create(request.body));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post(`${basePath}/orders/:orderId/payments`, async (request, response) => {
    try {
      const order = await commerce.orders.getById(request.params.orderId);

      if (!order) {
        response.status(404).json({ error: "Order not found." });
        return;
      }

      const { provider } = await parsePaymentBody(request);
      response.status(201).json(await commerce.payments.createPayment(order, provider));
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
