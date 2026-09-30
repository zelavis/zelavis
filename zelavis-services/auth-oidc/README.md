# @zelavis/app-auth-oidc

An ordinary Zelavis auth plugin for validating OIDC access tokens through the
native `Request` authentication contract. It verifies issuer, audience,
algorithm allow-lists, signatures, and remote JWKS keys before mapping claims
to a Zelavis principal.

The optional `authorizationCode` configuration enables endpoint-backed login
and explicit account linking. Zelavis creates short-lived one-time flow state,
binds callbacks to state and nonce, uses S256 PKCE, verifies the returned ID
token against issuer/audience/algorithm/JWKS constraints, and never links an
existing account merely because an email address matches.

```ts
import { oidcBearerService } from "@zelavis/app-auth-oidc";

export const service = oidcBearerService({
  issuer: "https://identity.example.com",
  audience: "zelavis-project",
  jwksUrl: "https://identity.example.com/.well-known/jwks.json",
  authorizationCode: {
    clientId: "zelavis-project",
    authorizationEndpoint: "https://identity.example.com/oauth2/authorize",
    tokenEndpoint: "https://identity.example.com/oauth2/token",
    redirectUri: "https://app.example.com/zelavis/api/v1/auth/oauth/oidc/callback",
  },
});
```

The plugin requires explicit issuer, audience, JWKS URL, and an algorithm
allow-list (or its conservative asymmetric default). It never accepts an
unsigned token or derives trust from unverified token claims.

Login starts at `POST /auth/oauth/oidc/start`. Authenticated accounts can start
an explicit link at `POST /auth/oauth/oidc/link/start`; both complete through
`GET /auth/oauth/oidc/callback`.
