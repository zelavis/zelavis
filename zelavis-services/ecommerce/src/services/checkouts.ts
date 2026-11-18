import { Context, Effect, Layer } from "effect";
import type { CheckoutLine } from "../contracts/payment-provider.js";
import type { Checkout } from "../domain/entities.js";
import { CheckoutUnsupported, InvalidInput, NotFound, ProviderFailure, ProviderNotConfigured, UnknownProvider } from "../errors.js";
import type { EcommerceError } from "../errors.js";
import { Payments } from "./payments.js";
import { Repositories } from "./repositories.js";

export interface CheckoutInput {
  readonly provider: string; readonly customerId: string; readonly mode: "payment" | "subscription";
  readonly lines: readonly CheckoutLine[]; readonly successUrl: string; readonly cancelUrl: string;
  readonly metadata?: Readonly<Record<string, string>>;
}
export interface PortalInput { readonly provider: string; readonly returnUrl: string }

export function validateReturnUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new TypeError("Return URLs require HTTPS (or HTTP on loopback).");
  if (value.length > 2048) throw new TypeError("Return URL is too long.");
  return value;
}

export const callPaymentProvider = <A>(provider: string, operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: cause => cause && typeof cause === "object" && "_tag" in cause && cause._tag === "ProviderNotConfigured" ? new ProviderNotConfigured({ provider }) : new ProviderFailure({ provider, operation, cause }) });

export class Checkouts extends Context.Service<Checkouts, {
  create(input: CheckoutInput): Effect.Effect<Checkout, EcommerceError>;
  get(id: string): Effect.Effect<Checkout | undefined, EcommerceError>;
  portal(id: string, input: PortalInput): Effect.Effect<{ readonly url: string }, EcommerceError>;
}>()("zelavis/ecommerce/Checkouts") {
  static readonly layer = Layer.effect(Checkouts, Effect.gen(function* () {
    const repositories = yield* Repositories;
    const payments = yield* Payments;
    const providerFor = Effect.fn(function* (name: string) {
      const provider = yield* payments.getProvider(name);
      if (!provider) return yield* new UnknownProvider({ provider: name });
      return provider;
    });
    const create = Effect.fn("Checkouts.create")(function* (input: CheckoutInput) {
      yield* Effect.try({ try: () => {
        if (!input || !["payment", "subscription"].includes(input.mode) || !Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 20) throw new TypeError("Checkout requires 1–20 lines and a valid mode.");
        if (typeof input.provider !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(input.provider) || typeof input.customerId !== "string" || !input.customerId || input.customerId.length > 200 || typeof input.successUrl !== "string" || typeof input.cancelUrl !== "string") throw new TypeError("Invalid checkout identity or URL.");
        validateReturnUrl(input.successUrl); validateReturnUrl(input.cancelUrl);
        const currency = input.lines[0]?.currency;
        for (const line of input.lines) {
          if (typeof line.name !== "string" || !line.name || line.name.length > 200 || !Number.isSafeInteger(line.amount) || line.amount < 0 || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 10000 || !/^[A-Za-z]{3}$/.test(line.currency) || line.currency !== currency || !Number.isSafeInteger(line.amount * line.quantity)) throw new TypeError("Invalid checkout line.");
          if (line.interval && !["day", "week", "month", "year"].includes(line.interval) || line.intervalCount !== undefined && (!Number.isSafeInteger(line.intervalCount) || line.intervalCount < 1 || line.intervalCount > 36)) throw new TypeError("Invalid recurring interval.");
          if (input.mode === "subscription" && !line.interval || input.mode === "payment" && line.interval) throw new TypeError("Line intervals must match checkout mode.");
        }
        if (!Number.isSafeInteger(input.lines.reduce((sum, line) => sum + line.amount * line.quantity, 0))) throw new TypeError("Checkout total is too large.");
        const metadata = input.metadata ?? {};
        if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata) || Object.keys(metadata).length > 20 || Object.entries(metadata).some(([k,v]) => !k || k.length > 40 || typeof v !== "string" || v.length > 500)) throw new TypeError("Invalid checkout metadata.");
        input = { ...input, lines: Object.freeze(input.lines.map(line => Object.freeze({ ...line }))), metadata: Object.freeze({ ...metadata }) };
      }, catch: () => new InvalidInput({ field: "checkout", message: "Invalid checkout lines, URLs or metadata." }) });
      const provider = yield* providerFor(input.provider);
      if (!provider.createCheckout) return yield* new CheckoutUnsupported({ provider: input.provider });
      const customer = yield* repositories.customers.findById(input.customerId);
      if (!customer) return yield* new NotFound({ resource: "customer", id: input.customerId });
      const id = crypto.randomUUID();
      const session = yield* callPaymentProvider(input.provider, "createCheckout", () => provider.createCheckout!({ ...input, checkoutId: id, customer, metadata: input.metadata ?? {} }));
      yield* Effect.try({ try: () => { validateReturnUrl(session.url); if (!session.reference || session.reference.length > 200) throw new TypeError("Invalid reference"); }, catch: () => new ProviderFailure({ provider: input.provider, operation: "createCheckout", cause: "Invalid checkout session" }) });
      const now = new Date();
      if (session.customerReference) yield* repositories.customers.setProviderReference(customer.id, input.provider, session.customerReference, now);
      return yield* repositories.checkouts.create({ id, provider: input.provider, mode: input.mode, customerId: customer.id, lines: input.lines, reference: session.reference, url: session.url, status: "open", metadata: input.metadata ?? {}, createdAt: now, updatedAt: now });
    });
    const portal = Effect.fn("Checkouts.portal")(function* (id: string, input: PortalInput) {
      yield* Effect.try({ try: () => validateReturnUrl(input.returnUrl), catch: () => new InvalidInput({ field: "returnUrl", message: "Invalid portal return URL." }) });
      const provider = yield* providerFor(input.provider);
      if (!provider.createPortal) return yield* new CheckoutUnsupported({ provider: input.provider });
      const customer = yield* repositories.customers.findById(id);
      if (!customer) return yield* new NotFound({ resource: "customer", id });
      const reference = customer.providerReferences?.[input.provider];
      if (!reference) return yield* new InvalidInput({ field: "customer", message: "Customer has no reference at this provider." });
      const result = yield* callPaymentProvider(input.provider, "createPortal", () => provider.createPortal!({ customer, customerReference: reference, returnUrl: input.returnUrl }));
      yield* Effect.try({ try: () => validateReturnUrl(result.url), catch: () => new ProviderFailure({ provider: input.provider, operation: "createPortal", cause: "Invalid portal URL" }) });
      return result;
    });
    return Checkouts.of({ create, get: id => repositories.checkouts.findById(id), portal });
  }));
}
