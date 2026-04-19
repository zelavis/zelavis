# @zelavis/ecommerce-paypal

PayPal payment provider plugin for `@zelavis/ecommerce`.

This package uses PayPal's official server SDK and the Orders/Payments APIs for one-time payments, and PayPal's official Billing Subscriptions REST APIs for recurring billing.

## Runtime model

Use one PayPal plugin package across different deployments by either:

- passing a preconfigured PayPal `Client`
- passing `clientConfig`
- passing `clientId` and `clientSecret`

The package does not hardcode any specific deployment provider or backend framework.

## Environment option

`paypalPlugin` accepts `environment` as either PayPal SDK enum values or plain strings:

- `"sandbox"`
- `"production"`
- `"live"` (alias of `"production"`)
