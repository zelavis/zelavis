import type { EcommerceRepositories } from "../contracts/repositories.js";
import type { CouponService } from "../services/coupon-service.js";
import type { CustomerService } from "../services/customer-service.js";
import type { OrderService } from "../services/order-service.js";
import type { PaymentService } from "../services/payment-service.js";
import type { ProductService } from "../services/product-service.js";
import type { EcommerceService } from "../ecommerce-service.js";

export interface EcommerceContext {
  config: Record<string, unknown>;
  childServices: readonly EcommerceService[];
}

export interface EcommerceApi {
  context: EcommerceContext;
  repositories: EcommerceRepositories;
  customers: CustomerService;
  coupons: CouponService;
  products: ProductService;
  orders: OrderService;
  payments: PaymentService;
}
