import { decodeDelivery, decodeFulfillmentMessage } from "../services/fulfillment.js";
import { planProviderEvent, type EventKind, type EventState } from "../services/provider-events.js";
import type { ProviderEvent } from "../contracts/payment-provider.js";
import type {
  DatabaseRuntimeApi,
  Json as DatabaseJson,
  JsonObject as DatabaseJsonObject,
  TenantRuntimeApi,
  Document,
  DocumentWrite,
} from "zelavis/db";
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
import { Effect, Schema, Semaphore } from "effect";
import { Checkout } from "../domain/entities.js";
import { StorageFailure } from "../errors.js";

export interface EcommerceDatabaseCollections {
  checkouts: string;
  customers: string;
  coupons: string;
  products: string;
  orders: string;
  paymentAttempts: string;
  subscriptions: string;
}

export interface CreateDatabaseEcommerceRepositoriesOptions {
  tenantId: string;
  collections?: Partial<EcommerceDatabaseCollections>;
}

const defaultCollections: EcommerceDatabaseCollections = {
  checkouts: "commerce_checkouts",
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
  const decoded = Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(value)));
  return decoded as DatabaseJson;
}

function toDatabaseJsonObjectValue(value: Record<string, unknown>): DatabaseJsonObject {
  return Schema.decodeUnknownSync(Schema.JsonObject)(toDatabaseJsonValue(value)) as DatabaseJsonObject;
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
    Object.entries(record).map(([key, entry]) => {
      if (typeof entry !== "string" || !entry || entry.length > 200) throw new TypeError("Stored provider references must be nonempty strings of at most 200 characters.");
      return [key, entry];
    }),
  );
}

type StoredCommerceEntity = DatabaseJsonObject;

class DatabaseRepositorySupport {
  private readonly collectionPermit = Semaphore.makeUnsafe(1);
  private readonly ensuredCollections = new Set<string>();

  constructor(private readonly database: TenantRuntimeApi) {}

  /** Wraps one database call, naming it so a failure says what was being done. */
  call<A>(operation: string, run: () => Promise<A>): Effect.Effect<A, StorageFailure> {
    return Effect.tryPromise({
      try: run,
      catch: (cause) => new StorageFailure({ operation, cause }),
    });
  }

  decode<A>(operation: string, run: () => A): Effect.Effect<A, StorageFailure> {
    return Effect.try({ try: run, catch: cause => new StorageFailure({ operation, cause }) });
  }

  ensureCollection(name: string): Effect.Effect<void, StorageFailure> {
    return this.collectionPermit.withPermit(Effect.gen({ self: this }, function* () {
      if (this.ensuredCollections.has(name)) return;
      if (!(yield* this.call("collectionExists", () => this.database.documents.collectionExists(name)))) {
        yield* this.call("createCollection", () => this.database.documents.createCollection({ name, surface: "database", metadata: { plugin: "@zelavis/ecommerce" } }));
      }
      this.ensuredCollections.add(name);
    }));
  }

  setProviderReference(collection: string, id: string, provider: string, reference: string, at: Date): Effect.Effect<Customer, StorageFailure> {
    return this.ensureCollection(collection).pipe(Effect.andThen(() => this.call("setProviderReference", () =>
      this.database.documents.transaction(tx => Effect.runPromise(Effect.gen(function* () {
        const record = yield* Effect.tryPromise({ try: () => tx.get({ collection, id }), catch: cause => cause });
        if (!record) return yield* new StorageFailure({ operation: "setProviderReference", cause: "Customer is missing" });
        const existing = deserializeCustomer(record.data);
        const updated = { ...existing, providerReferences: { ...existing.providerReferences, [provider]: reference }, updatedAt: at };
        yield* Effect.tryPromise({ try: () => tx.update({ collection, id, data: serializeCustomer(updated), mode: "replace" }), catch: cause => cause });
        return updated;
      }))),
    )));
  }

  insert<T>(
    collection: string,
    id: string,
    entity: T,
    serialize: (entity: T) => StoredCommerceEntity,
  ): Effect.Effect<T, StorageFailure> {
    return this.ensureCollection(collection).pipe(
      Effect.andThen(() =>
        this.call(`insert(${collection}/${id})`, () =>
          this.database.documents.insert({ collection, id, data: serialize(entity) }))),
      Effect.as(entity),
    );
  }

  update<T>(
    collection: string,
    id: string,
    entity: T,
    serialize: (entity: T) => StoredCommerceEntity,
  ): Effect.Effect<T, StorageFailure> {
    return this.ensureCollection(collection).pipe(
      Effect.andThen(() =>
        this.call(`update(${collection}/${id})`, () =>
          this.database.documents.update({
            collection,
            id,
            data: serialize(entity),
            mode: "replace",
          }))),
      Effect.as(entity),
    );
  }

  findById<T>(
    collection: string,
    id: string,
    deserialize: (data: StoredCommerceEntity) => T,
  ): Effect.Effect<T | undefined, StorageFailure> {
    return this.ensureCollection(collection).pipe(
      Effect.andThen(() =>
        this.call(`findById(${collection}/${id})`, () =>
          this.database.documents.findById({ collection, id }))),
      Effect.flatMap(document => this.decode("decodeDocument", () => document ? deserialize(document.data) : undefined)),
    );
  }

  list<T>(
    collection: string,
    deserialize: (data: StoredCommerceEntity) => T,
  ): Effect.Effect<ReadonlyArray<T>, StorageFailure> {
    return this.ensureCollection(collection).pipe(
      Effect.andThen(() =>
        this.call(`list(${collection})`, () =>
          this.database.documents.findMany({
            collection,
            orderBy: [{ path: "updatedAt", direction: "desc" }],
          }))),
      Effect.flatMap(documents => this.decode("decodeDocuments", () => documents.map(document => deserialize(document.data)))),
    );
  }
}

function serializeCustomer(customer: Customer): StoredCommerceEntity {
  return {
    id: customer.id,
    ...(customer.accountId ? { accountId: customer.accountId } : {}),
    email: customer.email,
    ...(customer.principalId ? { principalId: customer.principalId } : {}),
    ...(customer.providerReferences ? { providerReferences: customer.providerReferences } : {}),
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
    ...(typeof data.principalId === "string" ? { principalId: data.principalId } : {}),
    ...(data.providerReferences ? { providerReferences: readOptionalStringRecord(data.providerReferences) } : {}),
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
    // Schema arrays are readonly; storage wants one it may own.
    couponCodes: [...order.couponCodes],
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
    ...(paymentAttempt.orderId ? { orderId: paymentAttempt.orderId } : {}),
    ...(paymentAttempt.subscriptionId ? { subscriptionId: paymentAttempt.subscriptionId } : {}),
    ...(paymentAttempt.checkoutId ? { checkoutId: paymentAttempt.checkoutId } : {}),
    ...(paymentAttempt.providerUpdatedAt ? { providerUpdatedAt: serializeDate(paymentAttempt.providerUpdatedAt) } : {}),
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
    (data.orderId !== undefined && typeof data.orderId !== "string") ||
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
    ...(typeof data.orderId === "string" ? { orderId: data.orderId } : {}),
    ...(typeof data.subscriptionId === "string" ? { subscriptionId: data.subscriptionId } : {}),
    ...(typeof data.checkoutId === "string" ? { checkoutId: data.checkoutId } : {}),
    ...(data.providerUpdatedAt ? { providerUpdatedAt: parseDate(data.providerUpdatedAt, "providerUpdatedAt") } : {}),
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
    ...(subscription.providerCustomerReference ? { providerCustomerReference: subscription.providerCustomerReference } : {}),
    ...(subscription.providerUpdatedAt ? { providerUpdatedAt: serializeDate(subscription.providerUpdatedAt) } : {}),
    ...(subscription.checkoutId ? { checkoutId: subscription.checkoutId } : {}),
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
    ...(typeof data.providerCustomerReference === "string" ? { providerCustomerReference: data.providerCustomerReference } : {}),
    ...(data.providerUpdatedAt ? { providerUpdatedAt: parseDate(data.providerUpdatedAt, "providerUpdatedAt") } : {}),
    ...(typeof data.checkoutId === "string" ? { checkoutId: data.checkoutId } : {}),
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
  setProviderReference(id: string, provider: string, reference: string, at: Date) {
    return this.support.setProviderReference(this.collection, id, provider, reference, at);
  }

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
  database: DatabaseRuntimeApi,
  options: CreateDatabaseEcommerceRepositoriesOptions,
): EcommerceRepositories {
  const collections = {
    ...defaultCollections,
    ...options.collections,
  };
  const tenant = database.forTenant(options.tenantId);
  const support = new DatabaseRepositorySupport(tenant);

  const checkoutSchema = Schema.Struct({ ...Checkout.fields, createdAt: Schema.DateFromString, updatedAt: Schema.DateFromString });
  const checkoutJson = (value: Checkout) => toDatabaseJsonObjectValue({ ...value, lines: [...value.lines], createdAt: serializeDate(value.createdAt), updatedAt: serializeDate(value.updatedAt) });
  const checkoutFrom = (value: StoredCommerceEntity): Checkout => Schema.decodeUnknownSync(checkoutSchema)(value);
  const codecs = {
    checkouts: { encode: checkoutJson, decode: checkoutFrom },
    customers: { encode: serializeCustomer, decode: deserializeCustomer },
    subscriptions: { encode: serializeSubscription, decode: deserializeSubscription },
    paymentAttempts: { encode: serializePaymentAttempt, decode: deserializePaymentAttempt },
  };
  const applyEvent = (provider: string, event: ProviderEvent, attempt = 0): Effect.Effect<boolean, StorageFailure> => Effect.gen(function* () {
    for (const kind of Object.keys(codecs) as EventKind[]) yield* support.ensureCollection(collections[kind]);
    const state: EventState = {};
    const originals = new Map<string, Document>();
    const kind: EventKind = event.type === "checkout.completed" ? "checkouts" : event.type === "subscription.updated" ? "subscriptions" : "paymentAttempts";
    const reference = event.type === "checkout.completed" ? event.checkoutReference : event.type === "subscription.updated" ? event.subscriptionReference : event.paymentReference;
    const matches = yield* support.call("findProviderReference", () => tenant.documents.findMany({ collection: collections[kind], where: [{ path: "provider", op: "eq", value: provider }, { path: "reference", op: "eq", value: reference }], limit: 2 }));
    if (matches.length > 1) return yield* new StorageFailure({ operation: "ambiguousProviderReference", cause: "Provider reference is not unique" });
    const target = matches[0];
    if (!target && (event.type === "payment.succeeded" || event.type === "payment.failed") && event.subscriptionReference) {
      const subscriptions = yield* support.call("findInvoiceSubscription", () => tenant.documents.findMany({ collection: collections.subscriptions, where: [{ path: "provider", op: "eq", value: provider }, { path: "reference", op: "eq", value: event.subscriptionReference! }], limit: 2 }));
      if (subscriptions.length > 1) return yield* new StorageFailure({ operation: "ambiguousProviderReference", cause: "Subscription reference is not unique" });
      if (subscriptions[0]) state.subscription = yield* support.decode("decodeSubscription", () => deserializeSubscription(subscriptions[0]!.data));
    }
    if (!target && !state.subscription) return false;
    if (target) originals.set(`${kind}:${target.id}`, target);
    if (target && kind === "checkouts") {
      state.checkout = yield* support.decode("decodeCheckout", () => checkoutFrom(target.data));
      const customer = yield* support.call("eventCustomer", () => tenant.documents.findById({ collection: collections.customers, id: state.checkout!.customerId }));
      if (customer) { state.customer = yield* support.decode("decodeCustomer", () => deserializeCustomer(customer.data)); originals.set(`customers:${customer.id}`, customer); }
    } else if (target && kind === "subscriptions") state.subscription = yield* support.decode("decodeSubscription", () => deserializeSubscription(target.data));
    else if (target) state.payment = yield* support.decode("decodePayment", () => deserializePaymentAttempt(target.data));
    const plan = yield* support.decode("planProviderEvent", () => planProviderEvent(provider, event, state));
    if (!plan) return false;
    const operations: DocumentWrite[] = yield* support.decode("encodeProviderEvent", () => plan.changes.map((change): DocumentWrite => {
      const data = codecs[change.kind].encode(change.value as never);
      if (change.insert) return { _tag: "Insert", collection: collections[change.kind], id: change.value.id, data };
      const original = originals.get(`${change.kind}:${change.value.id}`)!;
      return { _tag: "Update", collection: collections[change.kind], id: change.value.id, data, mode: "replace", expectedVersion: original.version };
    }));
    yield* support.call("applyProviderEvent", () => tenant.documents.write({ operations, idempotencyKey: `${provider}:${event.eventId}`,
      emit: [{ id: `${provider}:${event.eventId}`, topic: `commerce.${event.type}`, payload: { record: toDatabaseJsonObjectValue({ ...plan.payload }), occurredAt: event.occurredAt.toISOString() } }],
    }));
    return true;
  }).pipe(Effect.catch(error => {
    if (attempt < 7 && error.cause && typeof error.cause === "object" && "_tag" in error.cause && error.cause._tag === "DocumentConflict") return applyEvent(provider, event, attempt + 1);
    return Effect.fail(error);
  }));
  return {
    events: { apply: applyEvent },
    fulfillment: {
      read: after => support.call("readFulfillment", () => tenant.outbox.read({ after: after as import("zelavis/db").EventCursor | undefined, limit: 50 })).pipe(Effect.flatMap(page => support.decode("decodeFulfillment", () => ({ ...page, messages: page.messages.map(decodeFulfillmentMessage) })))),
      get: id => support.findById("commerce_fulfillment_deliveries", id, decodeDelivery),
      save: delivery => support.ensureCollection("commerce_fulfillment_deliveries").pipe(Effect.andThen(() => support.call("saveDelivery", () => tenant.documents.write({ operations: [{ _tag: "Upsert", collection: "commerce_fulfillment_deliveries", id: delivery.id, data: { ...delivery } }] }))), Effect.asVoid),
      remove: message => Effect.gen(function* () {
        // Include acknowledgements left by a handler removed in a later service composition.
        // Delete a bounded page before dropping the message, so a crash can only cause redelivery.
        const records = yield* support.call("deliveryCleanupPage", () => tenant.documents.findMany({ collection: "commerce_fulfillment_deliveries", where: [{ path: "messageId", op: "eq", value: message }], limit: 50 }));
        if (records.length) yield* support.call("removeDeliveries", () => tenant.documents.write({ operations: records.map(record => ({ _tag: "Delete", collection: "commerce_fulfillment_deliveries", id: record.id })) }));
        const remaining = yield* support.call("deliveryCleanupRemaining", () => tenant.documents.findMany({ collection: "commerce_fulfillment_deliveries", where: [{ path: "messageId", op: "eq", value: message }], limit: 1 }));
        if (!remaining.length) yield* support.call("removeFulfillment", () => tenant.outbox.remove({ ids: [message] }));
      }),
      failures: after => support.ensureCollection("commerce_fulfillment_deliveries").pipe(Effect.andThen(() => support.call("fulfillmentFailures", () => tenant.documents.findPage({ collection: "commerce_fulfillment_deliveries", where: [{ path: "failed", op: "eq", value: true }], limit: 50, after: after as import("zelavis/db").DocumentCursor | undefined }))), Effect.flatMap(page => support.decode("decodeDeliveries", () => ({ deliveries: page.documents.map(document => decodeDelivery(document.data)), next: page.next })))),
    },
    checkouts: {
      create: value => support.insert(collections.checkouts, value.id, value, checkoutJson),
      update: value => support.update(collections.checkouts, value.id, value, checkoutJson),
      findById: id => support.findById(collections.checkouts, id, checkoutFrom),
      list: () => support.list(collections.checkouts, checkoutFrom),
    },
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
