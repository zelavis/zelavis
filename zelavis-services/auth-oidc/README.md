# @zelavis/app-auth-oidc

A Zelavis plugin that accepts JWT bearer tokens issued by an external OpenID
Connect provider, through the native `Request` authentication contract. It
declares the `zelavis/auth:authenticator` capability of Zelavis Auth.

This is machine-to-machine access: a caller already holding a token from the
issuer presents it in `Authorization: Bearer`, and the plugin verifies the
issuer, audience, algorithm allow-list and signature against the issuer's
remote JWKS before mapping the claims to a Zelavis principal. No sign-in
happens here and no account is created.

Browser sign-in with an OpenID Connect provider needs no plugin: Zelavis Auth
runs the Authorization Code flow itself, and an operator adds any issuer by
its URL under **Auth → OAuth** (`PUT /auth/oauth/connections/:name`). See the
[Auth docs](https://zelavis.com/packages/auth/).

```ts
import { oidcBearerService } from "@zelavis/app-auth-oidc";

export const service = oidcBearerService({
  issuer: "https://id.example.com",
  audience: "zelavis-project",
  jwksUrl: "https://id.example.com/.well-known/jwks.json",
});
```

The plugin requires an explicit issuer, audience and JWKS URL, and an
algorithm allow-list (default `RS256`, `ES256`, `EdDSA`). It never accepts an
unsigned token or derives trust from unverified claims. `mapPrincipal` maps
claims to a principal; by default the token's `sub` becomes a `user` principal.
