# @zelavis/app-auth-oidc

An ordinary Zelavis auth plugin for validating OIDC access tokens through the
native `Request` authentication contract. It verifies issuer, audience,
algorithm allow-lists, signatures, and remote JWKS keys before mapping claims
to a Zelavis principal.

Interactive authorization-code login, provider-specific account linking, and
consent UI remain separate endpoint workflows built on this verifier.

```ts
import { oidcBearerService } from "@zelavis/app-auth-oidc";

export const service = oidcBearerService({
  issuer: "https://identity.example.com",
  audience: "zelavis-project",
  jwksUrl: "https://identity.example.com/.well-known/jwks.json",
});
```

The plugin requires explicit issuer, audience, JWKS URL, and an algorithm
allow-list (or its conservative asymmetric default). It never accepts an
unsigned token or derives trust from unverified token claims.
