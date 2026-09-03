---
"zelavis": minor
---

Add an identity provider by pasting its issuer URL, and list plugin extensions
by what they extend.

Every OpenID Connect issuer publishes its endpoints at
`/.well-known/openid-configuration`. Configuring a connection with an `issuer`
reads that document and registers the provider, so Google, Microsoft, Okta,
Auth0, Keycloak, or a company's own SSO is a URL rather than a plugin or a
release. The document's own `issuer` must match the URL requested and every
endpoint must be https, because one of them supplies the keys that decide
whether an ID token is genuine.

Google's constants are gone as a result: it is ordinary OIDC. GitHub stays,
because it issues no ID token and its profile endpoint and claim mapping are
real code rather than a list of URLs. That is the line for shipping a provider
definition at all.

`GET /runtime/extensions` lists services that extend another, grouped by what
they extend, optionally narrowed with `?owner=`. `zelavis extensions [--for
<service>]` is the same over the command line, and each service in the registry
listing now carries `extends`, so a general catalogue can leave extensions out
and show them beside the plugin they extend instead. Installing an extension
whose owner is absent is refused rather than silently doing nothing.

Fixes capability parsing reading any unknown prefix as a service. `app:project`
is a domain namespace, and treating it as an owner invented an extension point
called "app" with the shipped Project recipes listed under it. A service owner
is now recognised by containing a `/`, which every service name does.
