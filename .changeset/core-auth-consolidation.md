---
"zelavis": major
---

Move password sign-in and the OAuth client into Zelavis itself, and remove the
auth plugins.

Password auth was two nearly identical plugins — one keyed on an email address,
one on a username — that the distribution copied into the product-services
folder on first boot. That seeding existed because a Platform with no
credential provider can never create its first owner, which made the plugin
mandatory in everything but name. It is now one built-in provider that decides
from the identifier which kind it was given, and the seeding machinery is gone.

`@zelavis/auth` is gone too. Core already ran the Authorization Code flow —
holding the state, nonce, and PKCE verifier — so the plugin only wrapped the
client around it. Those are the parts of a redirect flow that are dangerous to
get wrong and identical for every provider, so they are written and audited
once rather than per plugin.

What stays extensible is what is actually vendor-specific. A plugin declaring
`zelavis/auth:oauth` supplies one identity provider's endpoints and claim
mapping; Google, GitHub, and a generic OIDC builder ship in the box. The
credentials an installation was issued are the operator's and are configured
through `/auth/oauth/connections`, where the client secret is write-only.

`@zelavis/app-auth-oidc` remains, narrowed to a JWT bearer authenticator for
callers already holding a token from an issuer.

Breaking: the provider name is `password`, not `email-password` or
`username-password`, and `zelavis bootstrap` defaults to it.
