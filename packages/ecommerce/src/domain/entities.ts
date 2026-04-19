export interface Customer {
  id: string;
  accountId?: string;
  email: string;
  firstName?: string;
  lastName?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Coupon {
  code: string;
  description?: string;
  discountType: "percentage" | "fixed";
  discountValue: number;
  active: boolean;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductPrice {
  amount: number;
  currency: string;
}

export interface Product {
  id: string;
  slug: string;
  title: string;
  description?: string;
  price: ProductPrice;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderLineItem {
  productId: string;
  quantity: number;
  unitPrice: number;
}

export interface OrderTotals {
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  grandTotal: number;
  currency: string;
}

export interface Order {
  id: string;
  customerId: string;
  items: OrderLineItem[];
  couponCodes: string[];
  status: "draft" | "pending" | "paid" | "cancelled" | "fulfilled";
  totals: OrderTotals;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentAttempt {
  id: string;
  orderId: string;
  provider: string;
  amount: number;
  currency: string;
  status: "requires_action" | "authorized" | "captured" | "failed" | "refunded";
  reference?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export type SubscriptionInterval = "day" | "week" | "month" | "year";

export interface BillingSubscription {
  id: string;
  customerId: string;
  provider: string;
  amount: number;
  currency: string;
  interval: SubscriptionInterval;
  intervalCount: number;
  status: "pending" | "active" | "past_due" | "cancelled" | "expired" | "failed";
  cancelAtPeriodEnd: boolean;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  reference?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
