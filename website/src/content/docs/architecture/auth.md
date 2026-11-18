---
title: Zelavis Auth
description: How Zelavis Auth keeps accounts, sessions and sign-in methods per runtime, its transactional guarantees, and its limits.
---

Zelavis Auth (`zelavis/auth`, source in `packages/zelavis/src/auth`) is the one
authentication engine of Zelavis. Every runtime composes its own instance: the
Platform for the people who administer Zelavis, and each App for that App's
users. How to use it (methods, invitations, sessions, MFA, routes) is on the
[Auth package page](/packages/auth/); this page describes the design.

## One Auth per runtime

| | Platform | App |
| --- | --- | --- |
| Database | the Platform identity database, `<data>/identity-database/` | the App's own Project database |
| Auth partition | Tenant `service:zelavis-auth` | Tenant `service:zelavis-auth` |
| Access-token issuer | `zelavis:platform:<keySetId>` | `zelavis:project:<projectId>` |
| Access cookie | `zelavis_access` | `zelavis_app_<audience>` |
| Default sign-up role | `customer` | `user` |

Platform users and App users never share a database, signing key, issuer or
cookie. A Platform operator acts on an App only through the Project Gateway's
signed, audience-bound authority, and the App's public origin receives only that
App's own credentials. The identity database is never handed to services or
routes; Platform backups capture it as the `identity` component, and
`zelavis identity-database restore` puts a backup back host-locally.

## Modules in one partition

Auth is split into focused modules: `core`
(sessions, refresh tokens), `username`, `password`, `email`, `oauth`, `google`,
`apple`, `github`, `passkey` and `totp`. Zelavis adds its own modules on the same
engine: `accounts` (roles, permissions and grants), `registration`, `bootstrap`,
`admin`, `serviceAccounts`, `security` (security events, kept 90 days), `keys`
and `invitations`. A module owns its tables (collections named
`<module>_<table>`, such as `core_sessions`) and is called only through its
exported functions.

Every module's tables live in the runtime's one Auth partition. That is what
makes a sign-up atomic: the account, its username or email, its password, the
registration check and the first session commit together or not at all.

## Transactions instead of claims

Each Auth operation is one tenant document transaction
(`documents.transaction` in `zelavis/db`): the body runs against a snapshot, and
its read set is checked again under the partition's writer before the batch
commits, retrying on a conflict (at most 8 attempts). Because the check and the
write happen in the same transaction:

- a username, a verified email address and a provider account each belong to at
  most one account;
- a refresh token, an email code, an OAuth ticket, a passkey challenge and an
  invitation are redeemed at most once;
- closing registration and a concurrent sign-up cannot both succeed;
- an administrator whose authority was just removed is refused, even for a
  request already past its route check.

Password hashing, WebAuthn verification and calls to an OAuth provider run
outside the transaction, so a slow step never holds the partition's writer.
Background clean-up (expired challenges, OAuth flows, pending MFA sign-ins,
unredeemed tokens, rate-limit buckets, old security events) runs as bounded
sweeps of at most 200 rows a run.

## Sessions and tokens

A session row is created per sign-in, with at most 100 per account and a
30-day inactivity timeout and lifetime by default. Refresh tokens rotate: each
one is redeemed into the next at most once, and presenting a spent or dropped
token revokes its session. Access tokens are ES256 JWTs signed by the runtime's
own key (sealed at rest with the runtime's master secret), valid for 300
seconds by default (at most an hour), with public keys at `GET /auth/jwks`. Every
request verifies the token and reads its session row, so signing out, recovery,
an access change or an MFA reset stops a session at once.

Zelavis pages keep both tokens in HttpOnly cookies and refresh under a
cross-tab lock. The SDK, CLI and native clients hold the token bundle
themselves and use `POST /auth/session/refresh`.

Raw secrets are never stored: refresh tokens, email codes, browser secrets,
OAuth state, tickets and service-account tokens are SHA-256 hashes, and TOTP
secrets, signing keys and OAuth client secrets are sealed with the runtime's
master secret. Rate limits are token buckets kept in the Auth partition, keyed
by the target (address, username, account) and by the
[client address](/architecture/access-control/#client-address).

## Transactional runtime and license

Every Auth operation executes through Zelavis primitives: tenant document
transactions for atomic state changes, the request's client address for
per-IP limits, the runtime's email outbox for mail, and bounded sweeps for
background cleanup.

Derived third-party Auth files keep the Apache License 2.0 (`LICENSE-APACHE`
and `NOTICE` in the `zelavis` package, indexed in
`packages/zelavis/src/auth/upstream.json`), so the package's license is
`MIT AND Apache-2.0`.

## Plugins

Google, Apple, GitHub and any OpenID Connect issuer (added by its issuer URL)
need no plugin. Two capabilities extend Auth:

- `zelavis/auth:oauth`: a plugin names OpenID Connect issuers ahead of time
  (`defineOAuthProviders` from `zelavis/auth`); the operator still supplies the
  client credentials.
- `zelavis/auth:authenticator`: a bearer authenticator that resolves a token
  into a principal, such as `@zelavis/app-auth-oidc`.

There are no custom credential-exchange plugins. Services read the caller and
the sign-in catalogue through `core.auth` (`principalFor`, `methods`,
`accounts.get`).

## Upgrading from Identity

Releases up to `2.0.0-alpha.45` kept accounts in Identity, an earlier engine.
The Platform imports its accounts on **Update now**, and each App when it is
explicitly upgraded; see [Updates](/architecture/updates/#upgrading-from-identity-to-zelavis-auth).

## Limits

- No SAML single sign-on and no SCIM provisioning.
- One Auth writer per App: the Auth partition is not split across shards, so
  sign-in throughput is that of one partition writer.
- No live revocation push. A client learns that its session ended on its next
  request or refresh.
- Passkeys use one relying-party ID per runtime, with exact configured origins.
- Passkey sign-in is not followed by a TOTP challenge; a passkey is a
  phishing-resistant factor of its own.
- Anonymous sign-in is not ported.
- No single sign-on between the Platform and an App.
