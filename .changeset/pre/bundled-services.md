---
"@zelavis/ecommerce": patch
"@zelavis/ecommerce-stripe": patch
"@zelavis/ecommerce-paypal": patch
"@zelavis/app-auth-oidc": patch
---

Services are self-contained: the Stripe and PayPal plugins bundle their SDKs, `effect` and `zelavis` come from the Platform, and unused dependencies are gone, so the Platform accepts them.
