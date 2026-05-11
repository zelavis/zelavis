import type {
  CouponRepository,
  CustomerRepository,
  EcommerceRepositories,
  OrderRepository,
  PaymentAttemptRepository,
  ProductRepository,
  SubscriptionRepository,
} from "../contracts/repositories.js";
import type {
  BillingSubscription,
  Coupon,
  Customer,
  Order,
  PaymentAttempt,
  Product,
} from "../domain/entities.js";

class InMemoryCustomerRepository implements CustomerRepository {
  private readonly items = new Map<string, Customer>();

  async create(customer: Customer): Promise<Customer> {
    this.items.set(customer.id, customer);
    return customer;
  }

  async findById(id: string): Promise<Customer | null> {
    return this.items.get(id) ?? null;
  }

  async list(): Promise<Customer[]> {
    return Array.from(this.items.values());
  }

  async update(customer: Customer): Promise<Customer> {
    this.items.set(customer.id, customer);
    return customer;
  }
}

class InMemoryCouponRepository implements CouponRepository {
  private readonly items = new Map<string, Coupon>();

  async create(coupon: Coupon): Promise<Coupon> {
    this.items.set(coupon.code, coupon);
    return coupon;
  }

  async findByCode(code: string): Promise<Coupon | null> {
    return this.items.get(code) ?? null;
  }

  async list(): Promise<Coupon[]> {
    return Array.from(this.items.values());
  }

  async update(coupon: Coupon): Promise<Coupon> {
    this.items.set(coupon.code, coupon);
    return coupon;
  }
}

class InMemoryProductRepository implements ProductRepository {
  private readonly items = new Map<string, Product>();

  async create(product: Product): Promise<Product> {
    this.items.set(product.id, product);
    return product;
  }

  async findById(id: string): Promise<Product | null> {
    return this.items.get(id) ?? null;
  }

  async list(): Promise<Product[]> {
    return Array.from(this.items.values());
  }

  async update(product: Product): Promise<Product> {
    this.items.set(product.id, product);
    return product;
  }
}

class InMemoryOrderRepository implements OrderRepository {
  private readonly items = new Map<string, Order>();

  async create(order: Order): Promise<Order> {
    this.items.set(order.id, order);
    return order;
  }

  async findById(id: string): Promise<Order | null> {
    return this.items.get(id) ?? null;
  }

  async list(): Promise<Order[]> {
    return Array.from(this.items.values());
  }

  async update(order: Order): Promise<Order> {
    this.items.set(order.id, order);
    return order;
  }
}

class InMemoryPaymentAttemptRepository implements PaymentAttemptRepository {
  private readonly items = new Map<string, PaymentAttempt>();

  async create(paymentAttempt: PaymentAttempt): Promise<PaymentAttempt> {
    this.items.set(paymentAttempt.id, paymentAttempt);
    return paymentAttempt;
  }

  async findById(id: string): Promise<PaymentAttempt | null> {
    return this.items.get(id) ?? null;
  }

  async list(): Promise<PaymentAttempt[]> {
    return Array.from(this.items.values());
  }

  async update(paymentAttempt: PaymentAttempt): Promise<PaymentAttempt> {
    this.items.set(paymentAttempt.id, paymentAttempt);
    return paymentAttempt;
  }
}

class InMemorySubscriptionRepository implements SubscriptionRepository {
  private readonly items = new Map<string, BillingSubscription>();

  async create(subscription: BillingSubscription): Promise<BillingSubscription> {
    this.items.set(subscription.id, subscription);
    return subscription;
  }

  async findById(id: string): Promise<BillingSubscription | null> {
    return this.items.get(id) ?? null;
  }

  async list(): Promise<BillingSubscription[]> {
    return Array.from(this.items.values());
  }

  async update(subscription: BillingSubscription): Promise<BillingSubscription> {
    this.items.set(subscription.id, subscription);
    return subscription;
  }
}

export function createInMemoryEcommerceRepositories(
  overrides: Partial<EcommerceRepositories> = {},
): EcommerceRepositories {
  return {
    customers: overrides.customers ?? new InMemoryCustomerRepository(),
    coupons: overrides.coupons ?? new InMemoryCouponRepository(),
    products: overrides.products ?? new InMemoryProductRepository(),
    orders: overrides.orders ?? new InMemoryOrderRepository(),
    paymentAttempts: overrides.paymentAttempts ?? new InMemoryPaymentAttemptRepository(),
    subscriptions: overrides.subscriptions ?? new InMemorySubscriptionRepository(),
  };
}
