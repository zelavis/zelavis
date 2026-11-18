# Zelavis Auth (`src/auth`)

Zelavis Auth is derived from [Convex Auth v2](https://github.com/convex/convex-auth) (Apache-2.0). Each ported file
starts with a provenance header and has an entry in [`upstream.json`](upstream.json); `pnpm auth:upstream` lists what
upstream changed since the pin. `zelavis()` composes it once per runtime (`subsystem.ts`): the Platform on its identity
database, each App on its own Project database, both in the Tenant `service:zelavis-auth`.

| Here | Upstream (`packages/core/src/…`) | Kind |
| --- | --- | --- |
| `runtime/*` | Convex `ctx.db`, scheduler, rate limiter, batch worker, Resend | Zelavis-own adapter (part 4) |
| `core/tables.ts` | `component/schema.ts` | translated |
| `core/crypto.ts`, `core/expiry.ts` | `component/crypto.ts`, `component/expiry.ts` | copied |
| `core/sessions.ts` | `component/sessions.ts` | translated (token erasure is the `core.orphanTokens` sweep) |
| `core/public.ts` | `component/public.ts` | translated (access tokens signed by `keys`) |
| `core/setup.ts`, `core/userId.ts` | `server/setup.ts`, `server/userId.ts` | translated (`createAuthCore`, `bindMethod`) |
| `core/cookies.ts` | `ssr/cookies.ts` | translated (Set-Cookie collection, names and paths per runtime) |
| `lib/{types,ttl,crypto}.ts` | `lib/{types,ttl,crypto}.ts` | translated |
| `keys/*` | `ctx.auth.signJwt` and the deployment JWKS | Zelavis-own: per-runtime ES256 keys, sealed at rest |
| `accounts/*` | the app's users table | Zelavis-own: roles, permissions, grants and the principal |
| `core/authenticator.ts` | `ctx.auth.getUserIdentity` | Zelavis-own: bearer or access cookie, then the live session |
| `routes/*` | the app's exported session functions | Zelavis-own: `/auth/session*`, `/auth/sessions*`, `/auth/jwks`, `/auth/keys/rotate` |
| `username/{tables,public,validation}.ts` | `components/username/{schema,public,validation}.ts` | translated |
| `password/{tables,public,validation}.ts` | `components/password/{schema,public,validation}.ts` | translated (verification is `beginVerify`, a hash check outside the transaction, then `finishVerify` in the transaction that issues the session) |
| `password/{commonPasswords,commonPasswords.generated}.ts` | same names | copied |
| `password/hashing.ts`, `password/legacy.ts` | `password-hash-wasm/argon2id` | Zelavis-own: PBKDF2-SHA256 in PHC form; bcrypt, scrypt and Firebase verifiers for imported hashes |
| `lib/password.ts` | `lib/password.ts` | translated (15 characters minimum) |
| `methods/username-password.ts` | `methods/username-password/server.ts` | translated (`setupUsernamePassword`) |
| `routes/{username-password,user-errors,session-transport}.ts` | the app's exported mutations | Zelavis-own: `/auth/username-password/*`, one user-error table, cookies or tokens |
| `email/{tables,helpers,validation,verifiedEmails}.ts` | `components/email/{schema,helpers,validation,verifiedEmails}.ts` | translated (the three token buckets are the runtime's; the client address is `tx.request.ip`, `"unknown"` without a listener) |
| `email/challenge/{common,signUp,changeEmail,addEmail,custom}.ts` | `components/email/challenge/*.ts` | translated (a start emits its message into the transaction's outbox under `auth-<challengeId>`) |
| `email/cleanup.ts` | `components/email/cleanup.ts` | translated (the `email.expiredChallenges` sweep, at most 200 rows a run) |
| `email/templates.ts` | `helpers.ts` copy, `methods/email-password/server.ts` copy | Zelavis-own: text and HTML, links from the email settings' link base with the code in the fragment |
| `methods/email-password.ts` | `methods/email-password/server.ts` | translated (`setupEmailPassword`; hashing outside the transactions; mail through the runtime's `EmailOutbox`; add-email for any signed-in account is Zelavis-own) |
| `routes/email.ts` | the app's exported mutations | Zelavis-own: `/auth/email-password/*`, `/auth/emails*` |
| `lib/oauth/{constants,crypto,schema,dbHelpers,callback,redemption,authorize,http,providerFunctions}.ts`, `lib/oauthParams.ts` | same names under `lib/` | translated (the shared flow: authorization request, callback, one-time ticket; every provider shares the `oauth_authorizationRequests` and `oauth_tickets` tables; the callback URL is the connection's `redirectUri`; ticket and error travel in the URL fragment; the id_token echoes a nonce and, for an OpenID Connect connection, is verified against the issuer's key set) |
| `{google,apple,github}/*` | `components/{google,apple,github}/*` | translated (`constants.ts` copied; each keeps only its accounts table; Apple's client secret is signed per exchange) |
| `oauth/{tables,provider}.ts` | `components/oauth/{schema,provider}.ts` | translated (`oauth_accounts` serves every OpenID Connect connection) |
| `oauth/{connections,discovery,cleanup}.ts` | the app's provider catalogue | Zelavis-own: operator connections (secrets sealed), issuer-URL discovery, the `oauth.expired` sweep (upstream removes an abandoned flow only when its secret is presented) |
| `methods/{oauth,google,apple,github}.ts` | `methods/{oauth,google,apple,github}/server.ts` | translated (`setupOAuth` binds every provider and resolves its credentials per request; signed-in linking is Zelavis-own) |
| `routes/oauth.ts` | the app's exported mutations and the components' HTTP routes | Zelavis-own: `/auth/oauth/*` |
| `passkey/{tables,helpers,validation,registration,authentication,cleanup}.ts` | `components/passkey/*` | adapted to the Auth partition and bounded sweep. SimpleWebAuthn verifies attestation and assertions before the final transaction |
| `methods/username-passkey/{options,base64url,purposes,aaguids}.ts` | same names under `methods/username-passkey/` | copied with attribution and import adjustments |
| `methods/username-passkey/server.ts`, `passkey/settings.ts`, `routes/passkeys.ts` | `methods/username-passkey/server.ts` and `management/*` | username sign-up, username and autofill sign-in, and session-bound passkey management |
| `totp/{totp,backupCodes,validation,helpers,tables,enrollment}.ts` | `components/totp/{totp,backupCodes,validation,helpers,schema,enrollment}.ts` | translated (`hotp`, `totp` and `hashBackupCode` are Effects; the secret is sealed with the runtime's master secret instead of stored as raw bytes) |
| `totp/{gate,verify,policy,cleanup}.ts` | none (upstream does not wire TOTP into sign-in) | Zelavis-own: the second-factor gate in `completeSignIn`, pending sign-ins (challenge hashed, profile sealed), code verification with replay, per-challenge and per-account limits, the MFA policy, the reset, the `totp.expiredPendingSignIns` sweep |
| `methods/totp.ts`, `routes/totp.ts` | none | Zelavis-own: `setupMfa`, `/auth/mfa*` |
| `access/{access,delegation}.ts` | none | Zelavis-own, moved from Identity: access-edit input and bounds, the Gateway's Project delegation proof, and delegation checked inside the writing transaction against the administrator's current account |
| `registration/{errors,tables,policy}.ts` | none | Zelavis-own: the registration setting, admitted by the core's `completeSignUp`/`signUpWithoutSession` in the sign-up's own transaction (10 an hour per client address, 60 a minute per runtime); closed on the Platform until the first owner exists |
| `bootstrap/*` | none | Zelavis-own: the first-owner claim, one transaction (owner, username, password, claim row, session) |
| `admin/{accounts,sessions,import}.ts` | none | Zelavis-own: paged account listing, creation with username and password, another account's sessions, account import |
| `serviceAccounts/*` | none | Zelavis-own: Platform service accounts, transactional service principal ownership (`owners`), and their `zvs_` bearer tokens (stored as hashes) |
| `security/*` | none | Zelavis-own: security events written in the transaction of their action, the `security.retention` sweep (90 days) |
| `methods/{catalogue,settings}.ts` | none | Zelavis-own: `GET /auth/methods`, enabled methods and their revisions, and the gate that answers `method_disabled` |
| `routes/admin.ts` | Identity's account routes | Zelavis-own: `/auth/accounts*` (including `DELETE /auth/accounts/:accountId/mfa`), `/auth/registration*`, `/auth/bootstrap`, `/auth/service-accounts*`, `/auth/security/events`, `/auth/methods*` |
| `invitations/*` | none | Zelavis-own: hashed one-time links, delegated access, atomic acceptance, and a bounded pending sweep |
| `roles/*`, `routes/roles.ts` | none | Zelavis-own: custom roles (at most 50 per runtime), each change one transaction against the catalogue revision with delegation checked there; assignments expanded into principals from an in-process copy the role routes clear after each change |
| `create-auth.ts` | `setupConvexAuth` wiring | Zelavis-own: `createAuth` per runtime |

The Zelavis account modules (registration, bootstrap, administration, service accounts, security events, the methods
catalogue and invitations) are modules of the same engine, each keeping its tables in the runtime's one Auth partition. Every sign-up is one transaction, so Identity's enrollment slots, pending accounts and bootstrap
cleanup are not carried. Administration re-reads the administrator inside the transaction that writes, so authority
taken away a moment ago is refused even for a request already past its route check. An access edit ends the
account's sessions, as Identity's session epoch did. Managed-account session routes can also list and revoke a
service account's bearer tokens. Bulk import checks identifiers in batches and commits one account at a time.

Generic OpenID Connect accounts are keyed by the verified issuer and subject. Authorization requests and tickets
carry the connection revision, as do pending second-factor sign-ins. Reconfiguring or removing a connection
invalidates its pending flows. Disabling a method invalidates its pending MFA challenges even if that method
is enabled again. Platform method settings keep the owner's password route enabled, using their username when
present and their email otherwise.

Verified email and password sign-in works without an email outbox. Email operations that need to send a message
report `email_unavailable`. Imported passwords retain their original format until replaced, even if they are
rehashed at sign-in. New and replacement passwords use the current format rules.

Password recovery binds the link to the account that owned the verified address when the link was issued. The service
checks the link and applies a per-client rate limit before hashing. The final transaction consumes the link, sets the
password, revokes the previous sessions and invalidates outstanding MFA sign-ins and enrollments.

Passkeys use one configured relying-party ID per runtime and exact configured origins. Changes to that configuration
invalidate in-flight ceremonies. A passkey account adds another credential by confirming with an existing passkey,
and removes one by confirming with a different passkey. Enrolling the first passkey on an account created through
another method needs a separate re-authentication flow.

TOTP is a second factor after password, email + password and OAuth sign-in: `completeSignIn` answers
`{ status: "mfa_required", challenge }` for an account with an active authenticator, or
`{ status: "mfa_enrollment_required", challenge }` when the runtime's MFA policy (`none`, `privileged`, `all`) requires
one it lacks, and creates no session until `POST /auth/mfa/verify` (or the enrollment confirmed with the challenge)
presents the factor. Passkey sign-in is not gated: a passkey is a phishing-resistant factor of its own. A challenge
lasts five minutes (ten to enroll), and five wrong codes end it. Verification, enrollment confirmation, and
authenticator management share a per-account limit on wrong codes.

Enrollment from a session requires the current password or, for a passwordless account, a session started in
the last ten minutes. Adding an authenticator to an enrolled account also requires a current code from an existing
authenticator or an unused backup code in the start request. Confirmation sends the `totpId` from the start response
and uses the same session or first-factor challenge. Activating the first authenticator ends every older session
except the session that started enrollment, if there was one. The last authenticator can be removed when policy allows it.
Password replacement and MFA reset invalidate outstanding MFA proofs. Reset also ends all of the account's sessions
and removes its authenticators and backup codes; its route is `DELETE /auth/accounts/:accountId/mfa`, for an
administrator who may manage the account.
