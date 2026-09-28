/**
 * The ecommerce domain, as schemas.
 *
 * These were interfaces, which TypeScript erases: nothing checked that a
 * `Product` crossing a route boundary or coming back from storage was actually
 * a product. A schema is one definition that both types the value and decodes
 * untrusted input into it, so the check happens where the data arrives rather
 * than nowhere.
 */
import { Schema } from "effect";

/** Free-form data a caller attaches; opaque to this domain. */
const Metadata = Schema.optional(Schema.Record(Schema.String, Schema.Unknown));

export class Customer extends Schema.Class<Customer>("zelavis/ecommerce/Customer")({
  id: Schema.NonEmptyString,
  accountId: Schema.optional(Schema.String),
  email: Schema.NonEmptyString,
  firstName: Schema.optional(Schema.String),
  lastName: Schema.optional(Schema.String),
  metadata: Metadata,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
}) {}

export class Coupon extends Schema.Class<Coupon>("zelavis/ecommerce/Coupon")({
  code: Schema.NonEmptyString,
  description: Schema.optional(Schema.String),
  discountType: Schema.Literals(["percentage", "fixed"]),
  discountValue: Schema.Number,
  active: Schema.Boolean,
  metadata: Metadata,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
}) {}

export class ProductPrice extends Schema.Class<ProductPrice>("zelavis/ecommerce/ProductPrice")({
  amount: Schema.Number,
  currency: Schema.NonEmptyString,
}) {}

export class Product extends Schema.Class<Product>("zelavis/ecommerce/Product")({
  id: Schema.NonEmptyString,
  slug: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  description: Schema.optional(Schema.String),
  price: ProductPrice,
  metadata: Metadata,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
}) {}

export class OrderLineItem extends Schema.Class<OrderLineItem>("zelavis/ecommerce/OrderLineItem")({
  productId: Schema.NonEmptyString,
  quantity: Schema.Number,
  unitPrice: Schema.Number,
}) {}

export class OrderTotals extends Schema.Class<OrderTotals>("zelavis/ecommerce/OrderTotals")({
  subtotal: Schema.Number,
  discountTotal: Schema.Number,
  taxTotal: Schema.Number,
  grandTotal: Schema.Number,
  currency: Schema.NonEmptyString,
}) {}

export const OrderStatus = Schema.Literals([
  "draft",
  "pending",
  "paid",
  "cancelled",
  "fulfilled",
]);
/** The union a caller names; the const above is the schema that checks it. */
export type OrderStatus = typeof OrderStatus["Type"];

export class Order extends Schema.Class<Order>("zelavis/ecommerce/Order")({
  id: Schema.NonEmptyString,
  customerId: Schema.NonEmptyString,
  items: Schema.Array(OrderLineItem),
  couponCodes: Schema.Array(Schema.String),
  status: OrderStatus,
  totals: OrderTotals,
  metadata: Metadata,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
}) {}

export const PaymentStatus = Schema.Literals([
  "requires_action",
  "authorized",
  "captured",
  "failed",
  "refunded",
]);
/** The union a caller names; the const above is the schema that checks it. */
export type PaymentStatus = typeof PaymentStatus["Type"];

export class PaymentAttempt extends Schema.Class<PaymentAttempt>("zelavis/ecommerce/PaymentAttempt")({
  id: Schema.NonEmptyString,
  orderId: Schema.NonEmptyString,
  provider: Schema.NonEmptyString,
  amount: Schema.Number,
  currency: Schema.NonEmptyString,
  status: PaymentStatus,
  reference: Schema.optional(Schema.String),
  metadata: Metadata,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
}) {}

export const SubscriptionInterval = Schema.Literals(["day", "week", "month", "year"]);
/** The union a caller names; the const above is the schema that checks it. */
export type SubscriptionInterval = typeof SubscriptionInterval["Type"];

export const SubscriptionStatus = Schema.Literals([
  "pending",
  "active",
  "past_due",
  "cancelled",
  "expired",
  "failed",
]);
/** The union a caller names; the const above is the schema that checks it. */
export type SubscriptionStatus = typeof SubscriptionStatus["Type"];

export class BillingSubscription extends Schema.Class<BillingSubscription>(
  "zelavis/ecommerce/BillingSubscription",
)({
  id: Schema.NonEmptyString,
  customerId: Schema.NonEmptyString,
  provider: Schema.NonEmptyString,
  amount: Schema.Number,
  currency: Schema.NonEmptyString,
  interval: SubscriptionInterval,
  intervalCount: Schema.Number,
  status: SubscriptionStatus,
  cancelAtPeriodEnd: Schema.Boolean,
  currentPeriodStart: Schema.optional(Schema.Date),
  currentPeriodEnd: Schema.optional(Schema.Date),
  reference: Schema.optional(Schema.String),
  metadata: Metadata,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
}) {}
