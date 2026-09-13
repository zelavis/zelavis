import type {
  Coupon,
  Customer,
  Order,
  Product,
  BillingSubscription,
} from "./domain/entities.js";
import type { CreateProductInput } from "./services/product-service.js";
import type { CreateOrderInput } from "./services/order-service.js";
import type { CreateCustomerInput } from "./services/customer-service.js";
import type { CreateCouponInput } from "./services/coupon-service.js";
import type { CreateSubscriptionInput } from "./contracts/payment-provider.js";
import type { PluginOperationOptions } from "zelavis/sdk";

export interface EcommercePluginClient {
  readonly health: {
    get(input?: undefined, options?: PluginOperationOptions): Promise<{
      service: string;
      rootPath: string;
      apiBasePath: string;
      platform: { presets: unknown; resources: unknown };
    }>;
  };
  readonly products: {
    list(input?: undefined, options?: PluginOperationOptions): Promise<readonly Product[]>;
    create(input: CreateProductInput, options?: PluginOperationOptions): Promise<Product>;
    getById(input: undefined, options: PluginOperationOptions & { params: { id: string } }): Promise<Product>;
  };
  readonly orders: {
    list(input?: undefined, options?: PluginOperationOptions): Promise<readonly Order[]>;
    create(input: CreateOrderInput, options?: PluginOperationOptions): Promise<Order>;
    getById(input: undefined, options: PluginOperationOptions & { params: { id: string } }): Promise<Order>;
  };
  readonly customers: {
    list(input?: undefined, options?: PluginOperationOptions): Promise<readonly Customer[]>;
    create(input: CreateCustomerInput, options?: PluginOperationOptions): Promise<Customer>;
    getById(input: undefined, options: PluginOperationOptions & { params: { id: string } }): Promise<Customer>;
  };
  readonly coupons: {
    list(input?: undefined, options?: PluginOperationOptions): Promise<readonly Coupon[]>;
    create(input: CreateCouponInput, options?: PluginOperationOptions): Promise<Coupon>;
    getByCode(input: undefined, options: PluginOperationOptions & { params: { code: string } }): Promise<Coupon>;
  };
  readonly payments: {
    providers(input?: undefined, options?: PluginOperationOptions): Promise<{
      providers: readonly { name: string; plugin?: string }[];
    }>;
    attempts(input?: undefined, options?: PluginOperationOptions): Promise<readonly unknown[]>;
    create(
      input: { provider: string },
      options: PluginOperationOptions & { params: { id: string } },
    ): Promise<unknown>;
  };
  readonly subscriptions: {
    list(input?: undefined, options?: PluginOperationOptions): Promise<readonly BillingSubscription[]>;
    create(input: CreateSubscriptionInput, options?: PluginOperationOptions): Promise<BillingSubscription>;
    getById(input: undefined, options: PluginOperationOptions & { params: { id: string } }): Promise<BillingSubscription>;
    cancel(
      input: { providerName?: string; metadata?: Record<string, unknown> } | undefined,
      options: PluginOperationOptions & { params: { id: string } },
    ): Promise<BillingSubscription>;
  };
}

declare module "zelavis/sdk" {
  interface PluginApiRegistry {
    readonly ecommerce?: EcommercePluginClient;
  }
}
