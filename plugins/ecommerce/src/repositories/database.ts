import type { DatabaseApi, DatabaseJson, DatabaseJsonObject } from "@zelavis/app/db";
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

export interface EcommerceDatabaseCollections {
  customers: string;
  coupons: string;
  products: string;
  orders: string;
  paymentAttempts: string;
  subscriptions: string;
}

export interface CreateDatabaseEcommerceRepositoriesOptions {
  collections?: Partial<EcommerceDatabaseCollections>;
}

const defaultCollections: EcommerceDatabaseCollections = {
  customers: "commerce_customers",
  coupons: "commerce_coupons",
  products: "commerce_products",
  orders: "commerce_orders",
  paymentAttempts: "commerce_payment_attempts",
  subscriptions: "commerce_subscriptions",
};

function serializeDate(value: Date): string {
  return value.toISOString();
}

function toDatabaseJsonValue(value: unknown): DatabaseJson {
  return JSON.parse(JSON.stringify(value)) as DatabaseJson;
}

function toDatabaseJsonObjectValue(value: Record<string, unknown>): DatabaseJsonObject {
  return toDatabaseJsonValue(value) as DatabaseJsonObject;
}

function parseDate(value: unknown, field: string): Date {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be an ISO date string.`);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new TypeError(`${field} must be a valid ISO date string.`);
  }

  return parsed;
}

function readOptionalRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (value == null) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("metadata must be a JSON object when provided.");
  }

  return value as Record<string, unknown>;
}

function readOptionalStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  const record = readOptionalRecord(value);
  if (!record) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, String(entry)]),
  );
}

type StoredCommerceEntity = DatabaseJsonObject;

class DatabaseRepositorySupport {
  private readonly ensuredCollections = new Set<string>();

  constructor(private readonly database: DatabaseApi) {}

  async ensureCollection(name: string): Promise<void> {
    if (this.ensuredCollections.has(name)) {
      return;
    }

    if (!(await this.database.documents.collectionExists({ name }))) {
      await this.database.documents.createCollection({
        name,
        metadata: {
          surface: "ecommerce-service",
        },
      });
    }

    this.ensuredCollections.add(name);
  }

  async insert<T>(
    collection: string,
    id: string,
    entity: T,
    serialize: (entity: T) => StoredCommerceEntity,
  ): Promise<T> {
    await this.ensureCollection(collection);
    await this.database.documents.insert({
      collection,
      id,
      data: serialize(entity),
    });
    return entity;
  }

  async update<T>(
    collection: string,
    id: string,
    entity: T,
    serialize: (entity: T) => StoredCommerceEntity,
  ): Promise<T> {
    await this.ensureCollection(collection);
    await this.database.documents.update({
      collection,
      id,
      data: serialize(entity),
      mode: "replace",
    });
    return entity;
  }

  async findById<T>(
    collection: string,
    id: string,
    deserialize: (data: StoredCommerceEntity) => T,
  ): Promise<T | null> {
    await this.ensureCollection(collection);
    const document = await this.database.documents.findById({
      collection,
      id,
    });
    return document ? deserialize(document.data) : null;
  }

  async list<T>(
    collection: string,
    deserialize: (data: StoredCommerceEntity) => T,
  ): Promise<T[]> {
    await this.ensureCollection(collection);
    const documents = await this.database.documents.findMany({
      collection,
      orderBy: [
        {
          path: "updatedAt",
          direction: "desc",
        },
      ],
    });
    return documents.map((document: { data: StoredCommerceEntity }) =>
      deserialize(document.data),
    );
  }
}

function serializeCustomer(customer: Customer): StoredCommerceEntity {
  return {
    id: customer.id,
    ...(customer.accountId ? { accountId: customer.accountId } : {}),
    email: customer.email,
    ...(customer.firstName ? { firstName: customer.firstName } : {}),
    ...(customer.lastName ? { lastName: customer.lastName } : {}),
    ...(customer.metadata ? { metadata: toDatabaseJsonObjectValue(customer.metadata) } : {}),
    createdAt: serializeDate(customer.createdAt),
    updatedAt: serializeDate(customer.updatedAt),
  };
}

function deserializeCustomer(data: StoredCommerceEntity): Customer {
  if (typeof data.id !== "string" || typeof data.email !== "string") {
    throw new TypeError("Stored commerce customer is invalid.");
  }

  return {
    id: data.id,
    ...(typeof data.accountId === "string" ? { accountId: data.accountId } : {}),
    email: data.email,
    ...(typeof data.firstName === "string" ? { firstName: data.firstName } : {}),
    ...(typeof data.lastName === "string" ? { lastName: data.lastName } : {}),
    ...(readOptionalRecord(data.metadata) ? { metadata: readOptionalRecord(data.metadata) } : {}),
    createdAt: parseDate(data.createdAt, "createdAt"),
    updatedAt: parseDate(data.updatedAt, "updatedAt"),
  };
}

function serializeCoupon(coupon: Coupon): StoredCommerceEntity {
  return {
    code: coupon.code,
    ...(coupon.description ? { description: coupon.description } : {}),
    discountType: coupon.discountType,
    discountValue: coupon.discountValue,
    active: coupon.active,
    ...(coupon.metadata ? { metadata: toDatabaseJsonObjectValue(coupon.metadata) } : {}),
    createdAt: serializeDate(coupon.createdAt),
    updatedAt: serializeDate(coupon.updatedAt),
  };
}

function deserializeCoupon(data: StoredCommerceEntity): Coupon {
  if (
    typeof data.code !== "string" ||
    (data.discountType !== "percentage" && data.discountType !== "fixed") ||
    typeof data.discountValue !== "number" ||
    typeof data.active !== "boolean"
  ) {
    throw new TypeError("Stored commerce coupon is invalid.");
  }

  return {
    code: data.code,
    ...(typeof data.description === "string" ? { description: data.description } : {}),
    discountType: data.discountType,
    discountValue: data.discountValue,
    active: data.active,
    ...(readOptionalRecord(data.metadata) ? { metadata: readOptionalRecord(data.metadata) } : {}),
    createdAt: parseDate(data.createdAt, "createdAt"),
    updatedAt: parseDate(data.updatedAt, "updatedAt"),
  };
}

function serializeProduct(product: Product): StoredCommerceEntity {
  return {
    id: product.id,
    slug: product.slug,
    title: product.title,
    ...(product.description ? { description: product.description } : {}),
    price: toDatabaseJsonObjectValue({
      amount: product.price.amount,
      currency: product.price.currency,
    }),
    ...(product.metadata ? { metadata: toDatabaseJsonObjectValue(product.metadata) } : {}),
    createdAt: serializeDate(product.createdAt),
    updatedAt: serializeDate(product.updatedAt),
  };
}

function deserializeProduct(data: StoredCommerceEntity): Product {
  if (
    typeof data.id !== "string" ||
    typeof data.slug !== "string" ||
    typeof data.title !== "string" ||
    !data.price ||
    typeof data.price !== "object" ||
    Array.isArray(data.price) ||
    typeof (data.price as Record<string, unknown>).amount !== "number" ||
    typeof (data.price as Record<string, unknown>).currency !== "string"
  ) {
    throw new TypeError("Stored commerce product is invalid.");
  }

  return {
    id: data.id,
    slug: data.slug,
    title: data.title,
    ...(typeof data.description === "string" ? { description: data.description } : {}),
    price: {
      amount: (data.price as Record<string, unknown>).amount as number,
      currency: (data.price as Record<string, unknown>).currency as string,
    },
    ...(readOptionalRecord(data.metadata) ? { metadata: readOptionalRecord(data.metadata) } : {}),
    createdAt: parseDate(data.createdAt, "createdAt"),
    updatedAt: parseDate(data.updatedAt, "updatedAt"),
  };
}

function serializeOrder(order: Order): StoredCommerceEntity {
  return {
    id: order.id,
    customerId: order.customerId,
    items: order.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    })),
    couponCodes: order.couponCodes,
    status: order.status,
    totals: toDatabaseJsonObjectValue({
      subtotal: order.totals.subtotal,
      discountTotal: order.totals.discountTotal,
      taxTotal: order.totals.taxTotal,
      grandTotal: order.totals.grandTotal,
      currency: order.totals.currency,
    }),
    ...(order.metadata ? { metadata: toDatabaseJsonObjectValue(order.metadata) } : {}),
    createdAt: serializeDate(order.createdAt),
    updatedAt: serializeDate(order.updatedAt),
  };
}

function deserializeOrder(data: StoredCommerceEntity): Order {
  if (
    typeof data.id !== "string" ||
    typeof data.customerId !== "string" ||
    !Array.isArray(data.items) ||
    !Array.isArray(data.couponCodes) ||
    !["draft", "pending", "paid", "cancelled", "fulfilled"].includes(String(data.status)) ||
    !data.totals ||
    typeof data.totals !== "object" ||
    Array.isArray(data.totals)
  ) {
    throw new TypeError("Stored commerce order is invalid.");
  }

  const totals = data.totals as Record<string, unknown>;
  if (
    typeof totals.subtotal !== "number" ||
    typeof totals.discountTotal !== "number" ||
    typeof totals.taxTotal !== "number" ||
    typeof totals.grandTotal !== "number" ||
    typeof totals.currency !== "string"
  ) {
    throw new TypeError("Stored commerce order totals are invalid.");
  }

  return {
    id: data.id,
    customerId: data.customerId,
    items: data.items as unknown as Order["items"],
    couponCodes: data.couponCodes as string[],
    status: data.status as Order["status"],
    totals: {
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      taxTotal: totals.taxTotal,
      grandTotal: totals.grandTotal,
      currency: totals.currency,
    },
    ...(readOptionalRecord(data.metadata) ? { metadata: readOptionalRecord(data.metadata) } : {}),
    createdAt: parseDate(data.createdAt, "createdAt"),
    updatedAt: parseDate(data.updatedAt, "updatedAt"),
  };
}

function serializePaymentAttempt(paymentAttempt: PaymentAttempt): StoredCommerceEntity {
  return {
    id: paymentAttempt.id,
    orderId: paymentAttempt.orderId,
    provider: paymentAttempt.provider,
    amount: paymentAttempt.amount,
    currency: paymentAttempt.currency,
    status: paymentAttempt.status,
    ...(paymentAttempt.reference ? { reference: paymentAttempt.reference } : {}),
    ...(paymentAttempt.metadata
      ? { metadata: toDatabaseJsonObjectValue(paymentAttempt.metadata) }
      : {}),
    createdAt: serializeDate(paymentAttempt.createdAt),
    updatedAt: serializeDate(paymentAttempt.updatedAt),
  };
}

function deserializePaymentAttempt(data: StoredCommerceEntity): PaymentAttempt {
  if (
    typeof data.id !== "string" ||
    typeof data.orderId !== "string" ||
    typeof data.provider !== "string" ||
    typeof data.amount !== "number" ||
    typeof data.currency !== "string" ||
    !["requires_action", "authorized", "captured", "failed", "refunded"].includes(
      String(data.status),
    )
  ) {
    throw new TypeError("Stored commerce payment attempt is invalid.");
  }

  return {
    id: data.id,
    orderId: data.orderId,
    provider: data.provider,
    amount: data.amount,
    currency: data.currency,
    status: data.status as PaymentAttempt["status"],
    ...(typeof data.reference === "string" ? { reference: data.reference } : {}),
    ...(readOptionalRecord(data.metadata) ? { metadata: readOptionalRecord(data.metadata) } : {}),
    createdAt: parseDate(data.createdAt, "createdAt"),
    updatedAt: parseDate(data.updatedAt, "updatedAt"),
  };
}

function serializeSubscription(subscription: BillingSubscription): StoredCommerceEntity {
  return {
    id: subscription.id,
    customerId: subscription.customerId,
    provider: subscription.provider,
    amount: subscription.amount,
    currency: subscription.currency,
    interval: subscription.interval,
    intervalCount: subscription.intervalCount,
    status: subscription.status,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    ...(subscription.currentPeriodStart
      ? { currentPeriodStart: serializeDate(subscription.currentPeriodStart) }
      : {}),
    ...(subscription.currentPeriodEnd
      ? { currentPeriodEnd: serializeDate(subscription.currentPeriodEnd) }
      : {}),
    ...(subscription.reference ? { reference: subscription.reference } : {}),
    ...(subscription.metadata
      ? { metadata: toDatabaseJsonObjectValue(subscription.metadata) }
      : {}),
    createdAt: serializeDate(subscription.createdAt),
    updatedAt: serializeDate(subscription.updatedAt),
  };
}

function deserializeSubscription(data: StoredCommerceEntity): BillingSubscription {
  if (
    typeof data.id !== "string" ||
    typeof data.customerId !== "string" ||
    typeof data.provider !== "string" ||
    typeof data.amount !== "number" ||
    typeof data.currency !== "string" ||
    !["day", "week", "month", "year"].includes(String(data.interval)) ||
    typeof data.intervalCount !== "number" ||
    !["pending", "active", "past_due", "cancelled", "expired", "failed"].includes(
      String(data.status),
    ) ||
    typeof data.cancelAtPeriodEnd !== "boolean"
  ) {
    throw new TypeError("Stored commerce subscription is invalid.");
  }

  return {
    id: data.id,
    customerId: data.customerId,
    provider: data.provider,
    amount: data.amount,
    currency: data.currency,
    interval: data.interval as BillingSubscription["interval"],
    intervalCount: data.intervalCount,
    status: data.status as BillingSubscription["status"],
    cancelAtPeriodEnd: data.cancelAtPeriodEnd,
    ...(typeof data.currentPeriodStart === "string"
      ? { currentPeriodStart: parseDate(data.currentPeriodStart, "currentPeriodStart") }
      : {}),
    ...(typeof data.currentPeriodEnd === "string"
      ? { currentPeriodEnd: parseDate(data.currentPeriodEnd, "currentPeriodEnd") }
      : {}),
    ...(typeof data.reference === "string" ? { reference: data.reference } : {}),
    ...(readOptionalRecord(data.metadata) ? { metadata: readOptionalRecord(data.metadata) } : {}),
    createdAt: parseDate(data.createdAt, "createdAt"),
    updatedAt: parseDate(data.updatedAt, "updatedAt"),
  };
}

class DatabaseCustomerRepository implements CustomerRepository {
  constructor(
    private readonly support: DatabaseRepositorySupport,
    private readonly collection: string,
  ) {}
  create(customer: Customer) {
    return this.support.insert(this.collection, customer.id, customer, serializeCustomer);
  }
  findById(id: string) {
    return this.support.findById(this.collection, id, deserializeCustomer);
  }
  list() {
    return this.support.list(this.collection, deserializeCustomer);
  }
  update(customer: Customer) {
    return this.support.update(this.collection, customer.id, customer, serializeCustomer);
  }
}

class DatabaseCouponRepository implements CouponRepository {
  constructor(
    private readonly support: DatabaseRepositorySupport,
    private readonly collection: string,
  ) {}
  create(coupon: Coupon) {
    return this.support.insert(this.collection, coupon.code, coupon, serializeCoupon);
  }
  findByCode(code: string) {
    return this.support.findById(this.collection, code, deserializeCoupon);
  }
  list() {
    return this.support.list(this.collection, deserializeCoupon);
  }
  update(coupon: Coupon) {
    return this.support.update(this.collection, coupon.code, coupon, serializeCoupon);
  }
}

class DatabaseProductRepository implements ProductRepository {
  constructor(
    private readonly support: DatabaseRepositorySupport,
    private readonly collection: string,
  ) {}
  create(product: Product) {
    return this.support.insert(this.collection, product.id, product, serializeProduct);
  }
  findById(id: string) {
    return this.support.findById(this.collection, id, deserializeProduct);
  }
  list() {
    return this.support.list(this.collection, deserializeProduct);
  }
  update(product: Product) {
    return this.support.update(this.collection, product.id, product, serializeProduct);
  }
}

class DatabaseOrderRepository implements OrderRepository {
  constructor(
    private readonly support: DatabaseRepositorySupport,
    private readonly collection: string,
  ) {}
  create(order: Order) {
    return this.support.insert(this.collection, order.id, order, serializeOrder);
  }
  findById(id: string) {
    return this.support.findById(this.collection, id, deserializeOrder);
  }
  list() {
    return this.support.list(this.collection, deserializeOrder);
  }
  update(order: Order) {
    return this.support.update(this.collection, order.id, order, serializeOrder);
  }
}

class DatabasePaymentAttemptRepository implements PaymentAttemptRepository {
  constructor(
    private readonly support: DatabaseRepositorySupport,
    private readonly collection: string,
  ) {}
  create(paymentAttempt: PaymentAttempt) {
    return this.support.insert(
      this.collection,
      paymentAttempt.id,
      paymentAttempt,
      serializePaymentAttempt,
    );
  }
  findById(id: string) {
    return this.support.findById(this.collection, id, deserializePaymentAttempt);
  }
  list() {
    return this.support.list(this.collection, deserializePaymentAttempt);
  }
  update(paymentAttempt: PaymentAttempt) {
    return this.support.update(
      this.collection,
      paymentAttempt.id,
      paymentAttempt,
      serializePaymentAttempt,
    );
  }
}

class DatabaseSubscriptionRepository implements SubscriptionRepository {
  constructor(
    private readonly support: DatabaseRepositorySupport,
    private readonly collection: string,
  ) {}
  create(subscription: BillingSubscription) {
    return this.support.insert(
      this.collection,
      subscription.id,
      subscription,
      serializeSubscription,
    );
  }
  findById(id: string) {
    return this.support.findById(this.collection, id, deserializeSubscription);
  }
  list() {
    return this.support.list(this.collection, deserializeSubscription);
  }
  update(subscription: BillingSubscription) {
    return this.support.update(
      this.collection,
      subscription.id,
      subscription,
      serializeSubscription,
    );
  }
}

export function createDatabaseEcommerceRepositories(
  database: DatabaseApi,
  options: CreateDatabaseEcommerceRepositoriesOptions = {},
): EcommerceRepositories {
  const collections = {
    ...defaultCollections,
    ...options.collections,
  };
  const support = new DatabaseRepositorySupport(database);

  return {
    customers: new DatabaseCustomerRepository(support, collections.customers),
    coupons: new DatabaseCouponRepository(support, collections.coupons),
    products: new DatabaseProductRepository(support, collections.products),
    orders: new DatabaseOrderRepository(support, collections.orders),
    paymentAttempts: new DatabasePaymentAttemptRepository(
      support,
      collections.paymentAttempts,
    ),
    subscriptions: new DatabaseSubscriptionRepository(
      support,
      collections.subscriptions,
    ),
  };
}
