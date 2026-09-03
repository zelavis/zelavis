# @zelavis/auth-providers

Identity provider definitions for [`@zelavis/auth`](../auth): Google, GitHub,
and a builder for any standards-compliant OpenID Connect issuer.

Endpoints and claim shapes only. Nothing here is installation-specific, which
is what makes it shippable — the client id and secret an installation was
issued are configured by the operator against the provider name.

Install it alongside `@zelavis/auth`, then configure a provider through
`PUT /zelavis/api/v1/auth/connections/providers/:provider`.
