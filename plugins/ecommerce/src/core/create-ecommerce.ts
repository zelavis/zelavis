import type { EcommerceRepositories } from "../contracts/repositories.js";
import { CouponService } from "../services/coupon-service.js";
import { CustomerService } from "../services/customer-service.js";
import { OrderService } from "../services/order-service.js";
import { PaymentService } from "../services/payment-service.js";
import { ProductService } from "../services/product-service.js";
import { createInMemoryEcommerceRepositories } from "../repositories/in-memory.js";
import type { EcommerceService } from "../ecommerce-service.js";
import type { EcommerceApi } from "./types.js";

export interface CreateEcommerceOptions {
  config?: Record<string, unknown>;
  services?: readonly EcommerceService[];
  repositories?: Partial<EcommerceRepositories>;
}

export async function createEcommerce(options: CreateEcommerceOptions = {}): Promise<EcommerceApi> {
  const repositories = createInMemoryEcommerceRepositories(options.repositories);
  const customers = new CustomerService(repositories.customers);
  const coupons = new CouponService(repositories.coupons);
  const products = new ProductService(repositories.products);
  const orders = new OrderService(repositories.orders);
  const payments = new PaymentService(
    repositories.paymentAttempts,
    repositories.subscriptions,
  );

  const api: EcommerceApi = {
    context: {
      config: options.config ?? {},
      providers: Object.freeze([...(options.services ?? [])]),
    },
    repositories,
    customers,
    coupons,
    products,
    orders,
    payments,
  };

  for (const service of options.services ?? []) {
    await service.register(api);
  }

  return api;
}
