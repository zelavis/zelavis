import type {
  BillingSubscription,
  Coupon,
  Customer,
  Order,
  PaymentAttempt,
  Product,
} from "../domain/entities.js";

export interface CustomerRepository {
  create(customer: Customer): Promise<Customer>;
  findById(id: string): Promise<Customer | null>;
  list(): Promise<Customer[]>;
  update(customer: Customer): Promise<Customer>;
}

export interface CouponRepository {
  create(coupon: Coupon): Promise<Coupon>;
  findByCode(code: string): Promise<Coupon | null>;
  list(): Promise<Coupon[]>;
  update(coupon: Coupon): Promise<Coupon>;
}

export interface ProductRepository {
  create(product: Product): Promise<Product>;
  findById(id: string): Promise<Product | null>;
  list(): Promise<Product[]>;
  update(product: Product): Promise<Product>;
}

export interface OrderRepository {
  create(order: Order): Promise<Order>;
  findById(id: string): Promise<Order | null>;
  list(): Promise<Order[]>;
  update(order: Order): Promise<Order>;
}

export interface PaymentAttemptRepository {
  create(paymentAttempt: PaymentAttempt): Promise<PaymentAttempt>;
  findById(id: string): Promise<PaymentAttempt | null>;
  list(): Promise<PaymentAttempt[]>;
  update(paymentAttempt: PaymentAttempt): Promise<PaymentAttempt>;
}

export interface SubscriptionRepository {
  create(subscription: BillingSubscription): Promise<BillingSubscription>;
  findById(id: string): Promise<BillingSubscription | null>;
  list(): Promise<BillingSubscription[]>;
  update(subscription: BillingSubscription): Promise<BillingSubscription>;
}

export interface EcommerceRepositories {
  customers: CustomerRepository;
  coupons: CouponRepository;
  products: ProductRepository;
  orders: OrderRepository;
  paymentAttempts: PaymentAttemptRepository;
  subscriptions: SubscriptionRepository;
}
