---
"zelavis": minor
"@zelavis/app-auth-oidc": minor
"@zelavis/ecommerce": minor
"@zelavis/ecommerce-stripe": minor
"@zelavis/ecommerce-paypal": minor
---

Add native-Web request authentication, opaque persisted sessions, Web Crypto
password hashing, Basic/JWT/JWKS verifiers, and the OIDC bearer plugin. Move
Auth plugins out of the unified package and replace the retired child-service
graph with capability-discovered provider registration contracts. Add
provider-owned credential enrollment, token-gated first-owner bootstrap, real
Platform dashboard login/logout, session cookies and rotation, same-origin
cookie issuance and mutation enforcement, and permission gates for critical
control-plane endpoints.
