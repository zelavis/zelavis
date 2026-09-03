# @zelavis/auth

OAuth and OpenID Connect sign-in for Zelavis.

Core auth (`zelavis/auth`) owns accounts, sessions, credentials, permissions,
and the Authorization Code flow itself. This plugin is the layer above it: it
discovers identity provider definitions from plugins declaring
`@zelavis/auth:oauth`, pairs each with the credentials an operator configured,
and registers the result with core auth.

The two halves come from different people, which is why they are separate. A
provider plugin knows a provider's endpoints and claim shapes and can ship
them; only the operator has the client id and secret their installation was
issued from that provider.

## Configuring a provider

```bash
curl -X PUT https://example.com/zelavis/api/v1/auth/connections/providers/github \
  -H 'content-type: application/json' \
  -d '{
    "clientId": "...",
    "clientSecret": "...",
    "redirectUri": "https://example.com/zelavis/api/v1/auth/oauth/github/callback"
  }'
```

The client secret is write-only: it is never returned by any endpoint, and
omitting it on a later write keeps the stored one. A redirect URI must use
`https`, except on `localhost` — the authorization code arrives on that URL,
and a code is enough to complete a sign-in.

An installation that must come up already configured can set
`ZELAVIS_AUTH_<PROVIDER>_CLIENT_ID`, `_CLIENT_SECRET`, `_REDIRECT_URI`, and
`_SCOPES` instead. Anything stored through the API takes precedence, so a value
set once at deploy time does not override what an operator changed later.

Sign-in itself runs through core auth's existing endpoints:
`POST /auth/oauth/:provider/start` and `GET /auth/oauth/:provider/callback`.

## Writing a provider plugin

```ts
import { defineOAuthProviders } from "@zelavis/auth";

export default defineOAuthProviders("@acme/auth-gitlab", [
  {
    name: "gitlab",
    title: "GitLab",
    authorizationEndpoint: "https://gitlab.com/oauth/authorize",
    tokenEndpoint: "https://gitlab.com/oauth/token",
    issuer: "https://gitlab.com",
    jwksUrl: "https://gitlab.com/oauth/discovery/keys",
  },
]);
```

Declare `"capabilities": ["@zelavis/auth:oauth"]` in `package.json`. A
definition with an `issuer` must also give a `jwksUrl`: an ID token nobody can
verify is attacker-supplied JSON, so one is refused at definition time.

Providers with no ID token supply a `userInfoEndpoint` and usually a
`mapIdentity`. Prefer an immutable account id over a username — a username can
be released and taken by someone else, who would then inherit the account.
