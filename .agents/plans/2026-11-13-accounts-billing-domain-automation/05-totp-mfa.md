# TOTP multi-factor authentication

Job: Add multi-factor sign-in (TOTP with single-use recovery codes) to the Platform and native Apps, with an owner policy that can require it.
Date: 2026-11-13
Status: planned
Verified-at: b04fa02d95
Part: 5 of 10. Read 00-overview.md first.

To start:    Execute part 5 in .agents/plans/2026-11-13-accounts-billing-domain-automation/05-totp-mfa.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-13-accounts-billing-domain-automation/05-totp-mfa.md. Start with its section 8.

## Progress

- [ ] 1. Confirm part 3's tokens and the baseline.
- [ ] 2. Add TOTP and recovery-code primitives.
- [ ] 3. Add `CredentialRepository.mutate` on all backends.
- [ ] 4. Pass a runtime secret into identity.
- [ ] 5. Add the MFA service: enrollment, challenge, verify, policy.
- [ ] 6. Gate password and OAuth sign-in behind the challenge.
- [ ] 7. Expose routes, Gateway policy routes and App public routes.
- [ ] 8. Add SDK and CLI parity.
- [ ] 9. Add dashboard and App site pages.
- [ ] 10. Document MFA.
- [ ] 11. Self-audit.

## 0. Summary and finish line

Sign-in today is one factor: a password provider issues a session as soon as the password verifies (`packages/zelavis/src/app/identity/providers/password.ts:158-166`). This part lets any account enroll a TOTP authenticator (RFC 6238, SHA-1, 6 digits, 30 s) and receive ten recovery codes. Once enrolled, password and OAuth sign-in return a short-lived MFA challenge instead of a session; the session is issued only after a valid code. An owner policy can require MFA for privileged accounts or for everyone, in which case an unenrolled account's sign-in yields an enrollment challenge.

- **In scope**: TOTP and recovery-code primitives, encrypted factor storage as credentials, `CredentialRepository.mutate`, challenge tokens (part 3 repository), replay protection, rate limiting, policy per runtime, admin reset, routes on every runtime, Gateway routes for App policy, App public routes, SDK, CLI, dashboard and App site pages, docs, tests.
- **Out of scope**: WebAuthn/passkeys, SMS, remembered devices, step-up re-authentication for sensitive operations, service accounts (bearer API keys are unaffected by MFA).
- **Done means**: (a) enrollment requires the current password, returns an `otpauth://` URI, and activates only after a valid code, returning ten codes once; (b) sign-in for an enrolled account returns `{ status: "mfa_required", challenge }` and no cookie; `POST /auth/mfa/verify` with a valid TOTP or unused recovery code returns the session; (c) the same TOTP step and a used recovery code are refused on reuse; (d) five wrong codes end the challenge; (e) with policy `privileged`, an unenrolled operator gets `{ status: "mfa_enrollment_required", challenge }` and can enroll with it; (f) an admin with users permission can reset another account's MFA within delegation rules; (g) the App runtime has its own policy and factors; (h) parity, browser, `verify`, `ci:ui`, `docs:check` pass.
- **Supplement**: updated in this run (overview section 0).
- **Sources read**: `AGENTS.md § Core Access-Control Rule`, `§ Runtime Independence Rule`; parts 3-4; files below.

## 1. Context packet

**Glossary.**
- **Factor**: a stored second-factor credential: `mfa.totp` (one per account) or `mfa.recovery` (one record holding ten code hashes).
- **MFA challenge**: a part 3 account token, purpose `"mfa-challenge"` (5 minutes, 5 attempts), bound to `{ accountId, provider, amr }`, handed to the client instead of a session.
- **Enrollment challenge**: purpose `"mfa-enrollment"` (10 minutes), issued when policy requires MFA and the account has none; it authorizes only TOTP enrollment for that account.
- **Step**: `floor(unixSeconds / 30)`; a code is accepted for steps `current-1 .. current+1`.

**Governing rules.**
> "`zelavis/app/identity` owns authentication primitives: accounts, credentials, sessions, roles and permissions. It ships the credential ceremonies whose dangerous parts are generic and identical for every provider" `AGENTS.md § Core Access-Control Rule`
>
> "Zelavis core must only depend on the JavaScript language and standard platform APIs." `AGENTS.md § Runtime Independence Rule` (TOTP uses `crypto.subtle` HMAC; no `node:crypto` in identity.)

**System today.**
- Credential shape `packages/zelavis/src/app/identity/domain/entities.ts:48-57`; repository `contracts/repositories.ts:51-62` (no `mutate`).
- Provider API `contracts/credential-provider.ts:52-81`; `AuthenticationService.providerApi()` `services/authentication-service.ts:116-146`; `authenticate` `:340`; OAuth completion `:199`.
- Auth attempts limiter repository `contracts/repositories.ts:64-71` (used for sign-in throttling; find its service with `rg -n "attempts" packages/zelavis/src/app/identity/services/security-service.ts`).
- Encryption helpers `packages/zelavis/src/edge/acme-crypto.ts:79` `encryptSecret`, `:104` `decryptSecret`; per-store secret `packages/zelavis/src/platform/master-secret.ts:19`. Identity composition: Platform `packages/zelavis/src/index.ts:1619-1700`, App `packages/zelavis/src/app/app-service.ts:118-160` (called from `index.ts:6924-6950`); in both, `systemStore` is that runtime's own store (`packages/zelavis/src/adapters/node.ts:293-304`).
- Session principal `packages/zelavis/src/app/identity/core/session-authenticator.ts:48-77` (metadata carries provider info; sessions have `metadata` `entities.ts:28-40`).
- Part 3 handover: `AccountTokenRepository` (`create`, `consume`, `sweep`), `CredentialProviderApi.tokens`, `assertSessionAllowed` gate in `providerApi().sessions.create`. Check they exist.
- Sign-in UI: `packages/zelavis/services/zelavis-ui/app/auth-pages.ts:28-52` (`loginScreen`), App site `app/identity-site.ts`.

**Pattern to mirror.** Part 3's single-gate approach: put the MFA decision in `assertSessionAllowed` so every path that creates a session (password, OAuth, invitation acceptance, enrollment) is covered once. Timing-safe comparison as the password provider does via its own verify (`core/password.ts`).

**Traps.**
- Issuing the session and then asking for the code: the cookie already works. The gate runs before any session exists.
- Storing the TOTP secret hashed: it must be recoverable to compute codes; store it encrypted with the runtime secret.
- Accepting a code twice within its window: store `lastUsedStep` and update it with `mutate` atomically.
- Comparing codes with `===` on strings of attacker-chosen length: compare fixed-length digit strings in constant time.
- Counting challenge attempts by reading then writing: increment through `mutate` on the challenge's companion record (section 2).
- Letting MFA block service-account bearer tokens or the bootstrap flow: exempt service principals; bootstrap creates the owner, and policy applies at the owner's next sign-in.

## 2. Design

**Authority and scope.** Factors are credentials of the account in the runtime's identity repositories. Enrollment and removal need the account's own session plus its current password (enrollment) or a current code (removal), or an enrollment challenge. Admin reset needs users permission and passes `assertCanDelegateAccountAccess` against the target's current access (an operator cannot reset the owner). Policy changes need settings permission.

**Persistence.**
- `mfa.totp` credential: `{ provider: "mfa.totp", identifier: accountId, metadata: { secret: EncryptedSecret, confirmedAt?: string, lastUsedStep?: number } }`. Created unconfirmed at enrollment start (replacing an unconfirmed one), confirmed by the first valid code.
- `mfa.recovery` credential: `{ provider: "mfa.recovery", identifier: accountId, metadata: { codes: string[] /* 10 SHA-256 base64url hashes; a used one becomes "" */ } }`, written at confirmation; regenerating replaces it.
- Challenge attempt counter: the challenge token record gains optional `attempts?: number`; verification uses a NEW repository method `AccountTokenRepository.recordAttempt(tokenHash, purpose, now, limit): Promise<AccountToken | null>` that atomically increments and deletes at `limit`.
- Policy: NEW record `mfa-policy` in the identity repositories (System Store key `mfa-policy`; database: same collection as registration control) `{ schemaVersion: 1, requiredFor: "none" | "privileged" | "all", revision }`, default `none`.
- Encryption key: `${runtimeSecret}\u0000zelavis.identity.mfa`, where `runtimeSecret = loadPlatformMasterSecret(systemStore)` passed into `createIdentity` as NEW option `secretKey: string`.

**Flows.**
1. *Start enrollment* `POST /auth/mfa/totp { password }` (session) or `{ challenge }` (enrollment challenge): verify the password through the password provider's verify (session case); generate 20 random bytes; store unconfirmed; return `{ otpauthUri, secret }` where `otpauthUri = otpauth://totp/<issuer>:<label>?secret=<BASE32>&issuer=<issuer>&algorithm=SHA1&digits=6&period=30`, issuer = runtime name, label = email or username. Refuse if a confirmed factor exists (`mfa_already_enrolled`).
2. *Confirm* `POST /auth/mfa/totp/confirm { code, challenge? }`: valid code → set `confirmedAt`, `lastUsedStep`; generate 10 codes (10 characters from `[a-z2-9]`, shown as `xxxxx-xxxxx`); store hashes; bump `sessionEpoch` (ending other sessions); return `{ recoveryCodes }` once; with an enrollment challenge, consume it and also return a session.
3. *Sign-in*: `assertSessionAllowed(account, context)` (part 3) now returns a decision: `allow` | `mfa_required` | `mfa_enrollment_required` | refuse. For `mfa_required` it issues an MFA challenge bound to the provider and the would-be session's `expiresAt`; the route answers `200 { status: "mfa_required", challenge, expiresAt, factors: ["totp", "recovery"] }` with no cookie. For `mfa_enrollment_required` it issues an enrollment challenge: `200 { status: "mfa_enrollment_required", challenge, expiresAt }`. Privileged = roles `owner` or `operator`, or any permission or grant with system scope.
4. *Verify* `POST /auth/mfa/verify { challenge, code }`: `recordAttempt` (limit 5); TOTP: decrypt secret, compute codes for steps −1..+1, constant-time compare, then `credentials.mutate` to set `lastUsedStep` only if the matched step is greater than the stored one (else refuse as replay); recovery code: `mutate` to blank the matching hash (refuse when absent). Success consumes the challenge and creates the session with `metadata.amr = ["pwd" | "oauth", "otp"]`; answers like sign-in with the cookie.
5. *Remove* `DELETE /auth/mfa/totp { code }` (session): valid code → delete both credentials. Refused while policy requires MFA for this account (`mfa_required_by_policy`).
6. *Regenerate codes* `POST /auth/mfa/recovery-codes { code }`.
7. *Admin reset* `DELETE /auth/accounts/:accountId/mfa`: delegation check, delete both credentials, bump the target's `sessionEpoch`, security event `account.mfa.reset` (NEW type in `entities.ts:78-99`, no secrets).
8. *Status* `GET /auth/mfa` (session): `{ enrolled, confirmedAt?, recoveryCodesRemaining, requiredByPolicy }`.

**Invariants.**
1. No session for an enrolled account without a verified second factor in the same challenge.
2. A TOTP step is accepted at most once per account (`lastUsedStep` CAS); a recovery code at most once.
3. A challenge allows at most 5 verification attempts and lives 5 minutes.
4. Secrets are stored encrypted, returned only at enrollment start, never logged.

**Failure model.** NEW tags: `MfaCodeInvalidError` 400 `invalid_mfa_code` (wrong, replayed, expired challenge, too many attempts all say the same); `MfaAlreadyEnrolledError` 409 `mfa_already_enrolled`; `MfaRequiredByPolicyError` 409 `mfa_required_by_policy`; `MfaUnavailableError` 503 `mfa_unavailable` (no `secretKey`). Policy CAS conflict 409 `mfa_settings_conflict`.

**Concurrency, bounds, interruption.** All writes go through `mutate` or `consume`/`recordAttempt`. A crash after verify consumed the challenge and before the session was created loses the challenge; the user signs in again. Code verification work per request: 3 HMACs. Rate limit on `/auth/mfa/verify` also by runtime-wide key, 120 per minute.

**Decisions and rejected alternatives.** Challenge tokens over half-authenticated sessions: no core access-enforcement change, nothing to exempt. SHA-1/6/30: the only parameters every authenticator app supports. QR in the dashboard via `qrcode-generator@1.4.4` (zero dependencies, bundled into `@zelavis/ui`), with the secret also shown for manual entry.

**Decisions taken for the user.** Ten recovery codes; enrolling ends other sessions; policy default `none`; privileged = owner, operator or any system-scope authority.

**Needs from the user.** None.

## 3. Contracts

| HTTP (relative to the API base) | Access | SDK | CLI (`--json`) |
| --- | --- | --- | --- |
| `GET /auth/mfa` → status | session | `client.auth.mfa.status()` | `zelavis auth mfa-status` |
| `POST /auth/mfa/totp` `{ password } \| { challenge }` → `{ otpauthUri, secret }` | session or enrollment challenge | `client.auth.mfa.startTotp(input)` | `zelavis auth mfa-start --data JSON` |
| `POST /auth/mfa/totp/confirm` `{ code, challenge? }` → `{ recoveryCodes, session? }` | session or challenge | `client.auth.mfa.confirmTotp(input)` | `zelavis auth mfa-confirm --data JSON` |
| `DELETE /auth/mfa/totp` `{ code }` → 204 | session | `client.auth.mfa.removeTotp(code)` | `zelavis auth mfa-remove --data JSON` |
| `POST /auth/mfa/recovery-codes` `{ code }` → `{ recoveryCodes }` | session | `client.auth.mfa.regenerateRecoveryCodes(code)` | `zelavis auth mfa-recovery-codes --data JSON` |
| `POST /auth/mfa/verify` `{ challenge, code }` → session result | public (challenge) | `client.auth.mfa.verify(input)` | `zelavis auth mfa-verify --data JSON` |
| `GET\|PUT /auth/mfa/settings` `{ requiredFor, expectedRevision }` | settings permission | `client.auth.admin.mfaSettings()`, `.setMfaSettings(input)` | `zelavis auth mfa-settings`, `set-mfa-settings --data JSON` |
| `DELETE /auth/accounts/:accountId/mfa` → 204 | users permission + delegation | `client.auth.admin.resetMfa(accountId)` | `zelavis auth reset-mfa ACCOUNT` |
| `GET\|PUT /runtime/projects/:projectId/auth/mfa/settings` | `project.settings.manage` | `client.projects.mfaSettings(id)`, `.setMfaSettings(id, input)` | `zelavis projects mfa-settings PROJECT`, `set-mfa-settings PROJECT --data JSON` |
| `DELETE /runtime/projects/:projectId/auth/accounts/:accountId/mfa` | `project.users.manage` | `client.projects.resetMfa(id, accountId)` | `zelavis projects reset-mfa PROJECT ACCOUNT` |

Sign-in results become a union: `ZelavisAuthSessionResult | { status: "mfa_required"; challenge: string; expiresAt: string; factors: readonly ("totp" | "recovery")[] } | { status: "mfa_enrollment_required"; challenge: string; expiresAt: string }`. Codes: `^[0-9]{6}$` or `^[a-z2-9]{5}-?[a-z2-9]{5}$`. Bodies ≤ 2 KiB. App public allowlist adds `POST /auth/mfa/verify`, `/auth/mfa/totp`, `/auth/mfa/totp/confirm` (challenge-authorized forms) and page `/mfa`.

## 4. Execution steps

### 1. Confirm part 3's tokens and the baseline

- **Files**: none.
- **Change**: `rg -n "assertSessionAllowed" packages/zelavis/src/app/identity` and `rg -n "consume\(" packages/zelavis/src/app/identity/contracts/repositories.ts` find part 3's work.
- **Depends on**: part 3 (and 4 landed).
- **Check**: build; `pnpm --filter zelavis exec node --test --test-reporter=dot test/core-password-auth.test.mjs test/auth-oauth-oidc-flow.test.mjs test/identity-email-verification.test.mjs test/identity-invitations.test.mjs; echo "exit $?"` prints `exit 0`.

### 2. Add TOTP and recovery-code primitives

- **Goal**: pure, runtime-neutral code generation and checks.
- **Files**: **NEW** `packages/zelavis/src/app/identity/core/totp.ts`; **NEW** `packages/zelavis/test/identity-totp.test.mjs`.
- **Change**: `base32Encode(bytes)`, `base32Decode(text)`, `totpCode(secret, step): Effect<string>` (HMAC-SHA1 via `crypto.subtle`, dynamic truncation, 6 digits), `matchTotp(secret, code, nowMs, lastUsedStep?): Effect<number | undefined>` (returns the matched step greater than `lastUsedStep`), `generateRecoveryCodes(): string[]`, `hashCode(code): Effect<string>`, `constantTimeEqual(a, b)`, `otpauthUri({ issuer, label, secret })`.
- **Depends on**: 1.
- **Check**: rebuild; `pnpm --filter zelavis exec node --test test/identity-totp.test.mjs; echo "exit $?"` prints `exit 0` (RFC 6238 Appendix B vectors for SHA-1 truncated to 6 digits: T=59 → `287082`, T=1111111109 → `081804`, T=1234567890 → `005924`, with the ASCII secret `12345678901234567890`).

### 3. Add `CredentialRepository.mutate` on all backends

- **Goal**: linearizable credential updates.
- **Files**: `contracts/repositories.ts:51-62`; `storage/in-memory.ts`; `storage/database.ts`; `packages/zelavis/src/platform/auth-repositories.ts`; `packages/zelavis/test/identity-atomicity.test.mjs`.
- **Change**: `mutate(id, mutation: Mutation<Credential>): Promise<Credential | null>` mirroring `AccountRepository.mutate`; may not change `provider` or `identifier`. Add `AccountTokenRepository.recordAttempt`.
- **Depends on**: 2.
- **Check**: rebuild; atomicity tests: 32 concurrent mutations each incrementing a metadata counter end at 32 on each backend; `recordAttempt` deletes at the limit exactly once.

### 4. Pass a runtime secret into identity

- **Files**: `core/create-identity.ts:32-53`; `packages/zelavis/src/index.ts:1619-1700`; `packages/zelavis/src/app/app-service.ts:118-160` and its caller `index.ts:6924-6950`.
- **Change**: option `secretKey?: string`; compositions pass `yield* integration(() => loadPlatformMasterSecret(systemStore))` when a `systemStore` exists (import from `./platform/master-secret.js`). Without it, MFA routes answer 503 `mfa_unavailable`.
- **Depends on**: 3.
- **Check**: rebuild; `pnpm run typecheck; echo "exit $?"` prints `exit 0`.

### 5. Add the MFA service

- **Files**: **NEW** `packages/zelavis/src/app/identity/services/mfa-service.ts`; `domain/entities.ts:78-99` (security event); `core/errors.ts`; **NEW** `packages/zelavis/test/identity-mfa.test.mjs`.
- **Change**: flows 1, 2, 4-8 and the policy record with CAS.
- **Depends on**: 4.
- **Check**: rebuild; `pnpm --filter zelavis exec node --test test/identity-mfa.test.mjs; echo "exit $?"` (service-level cases) prints `exit 0`.

### 6. Gate password and OAuth sign-in behind the challenge

- **Files**: `services/authentication-service.ts` (`assertSessionAllowed` becomes `sessionDecision`), `:199`, `:340`; the signup and invitation-accept paths from parts 3-4; `identity-service.ts` sign-in route (`/authenticate/:provider`, find at `:802`) and OAuth callback (`:718-755`).
- **Change**: flow 3; route bodies per section 3; no cookie on challenge results. The OAuth callback renders a page that redirects the browser to `/mfa#challenge=…` for browser flows (read how the callback answers browsers today and keep that shape).
- **Depends on**: 5.
- **Check**: rebuild; `pnpm --filter zelavis exec node --test test/identity-mfa.test.mjs test/auth-oauth-oidc-flow.test.mjs test/core-password-auth.test.mjs; echo "exit $?"` prints `exit 0`.

### 7. Expose routes, Gateway policy routes and App public routes

- **Files**: `identity-service.ts`; `packages/zelavis/src/platform/project-gateway.ts` (policy and reset beside `registrationSettingsRoutes` `:670` and `accountAccessRoute` `:718`); `packages/zelavis/src/platform/project-public-auth.ts:11-17`.
- **Depends on**: 6.
- **Check**: rebuild; Gateway and public-host cases in `identity-mfa.test.mjs` and `platform-public-domain-forwarding.test.mjs` pass.

### 8. Add SDK and CLI parity

- **Files**: `packages/zelavis/src/sdk/fetch.ts` (new `mfa` object on `ZelavisAuthClient`, admin and Project methods, result union); `packages/zelavis/src/cli/auth-operations.ts`; `packages/zelavis/src/cli/projects.ts`.
- **Change**: section 3; fix callers of `signInWithPassword` that assume a session (typecheck lists them; the dashboard's login is updated in step 9).
- **Depends on**: 7.
- **Check**: rebuild; `pnpm --filter zelavis exec node --test test/capability-parity.test.mjs; echo "exit $?"`, `pnpm run typecheck; echo "exit $?"`; both `exit 0`.

### 9. Add dashboard and App site pages

- **Files**: `packages/zelavis/services/zelavis-ui/package.json` (add `"qrcode-generator": "1.4.4"` to the dependency group the bundle uses; check how other bundled libraries such as CodeMirror are declared); `app/auth-pages.ts` (login second step, `/mfa` screen); NEW `app/account-security-page.ts` at NEW route `/account/security` (status, enroll with QR and manual secret, confirm, show codes once with a copy button, regenerate, remove); Server → Access → Users and Project Users: "Reset MFA" action; `app/registration-settings.ts` or a NEW card for the MFA policy on Platform Auth settings and Project Auth; `src/auth-routes.ts` (`/mfa` public); `app/dashboard-routes.ts` (`/mfa`, `/account/security`); App site `src/identity-frontend-service.ts:7` and `app/identity-site.ts` (`/mfa` form and challenge handling after login); `scripts/test-embedded-server-views.mjs`.
- **Depends on**: 8.
- **Check**: run `pnpm install` from the root, then `git diff --stat pnpm-lock.yaml` shows only the `qrcode-generator` addition (no other version moved); then `pnpm --filter @zelavis/ui typecheck; echo "exit $?"`, `pnpm --filter @zelavis/ui test; echo "exit $?"`, `pnpm run ci:ui; echo "exit $?"`; all `exit 0`.

### 10. Document MFA

- **Files**: `website/src/content/docs/packages/auth.md`, `architecture/access-control.md`.
- **Change**: enrollment, codes, challenge flow, policy levels, admin reset, App independence, API keys unaffected, all three transports.
- **Depends on**: 9.
- **Check**: `pnpm run docs:check; echo "exit $?"` prints `exit 0`.

### 11. Self-audit

- **Check**: `pnpm run verify; echo "exit $?"`, `pnpm run ci:ui; echo "exit $?"`, `git diff --check; echo "exit $?"`; all `exit 0`.

## 5. Tests

`test/identity-totp.test.mjs`: RFC vectors (step 2); base32 round trip; `matchTotp` accepts ±1 step, refuses ±2, refuses `step <= lastUsedStep`; recovery codes are 10, unique, alphabet-limited.

`test/identity-mfa.test.mjs` (Platform and App runtimes, injected clock):
- Enrollment needs the password (wrong → 400 `invalid_credentials`); confirm with a wrong code → 400; with a right code → 10 codes; second start → 409 `mfa_already_enrolled`; other sessions ended.
- Password sign-in → `mfa_required`, no `set-cookie`; verify with the current code → session with `amr` including `otp`; same code again on a new challenge → 400 (replay); next step's code → success.
- Recovery code works once; status shows 9 remaining.
- Five wrong codes → challenge gone; sixth with the right code → 400.
- OAuth sign-in (fixture from `auth-oauth-oidc-flow.test.mjs`) for an enrolled account → challenge.
- Policy `privileged`: unenrolled owner → `mfa_enrollment_required`; enroll with the challenge → session and codes; a `customer` signs in normally. Policy `all`: the customer gets the enrollment challenge.
- Remove while required by policy → 409.
- Admin reset by an operator on a customer → 204, the customer's sessions end; on the owner → 403.
- Service account bearer token unaffected by policy `all`.
- Secrets: the raw stored credential holds an `EncryptedSecret`; no response after enrollment start includes `secret`.
- App: policy and factors independent from the Platform's; Gateway policy route needs `project.settings.manage` on that Project.

Browser (`scripts/test-embedded-server-views.mjs`, both sizes): enroll from `/account/security` (compute the code in the test from the shown secret with the test's own HMAC), save codes, sign out, sign in, enter a code on the second step, land on Projects. Recovery code path once. Wait for each page's own confirmation before reading state.

## 6. Docs and project notes

`website/src/content/docs/packages/auth.md`, `architecture/access-control.md`. No `pnotes/TODO.md` additions.

## 7. Verification

From the root: `pnpm run verify`, `pnpm run ci:ui`, `pnpm run docs:check`, `git diff --check`. Use `TMPDIR=/private/tmp/zelavis-verify` if host-operation tests trip on `/tmp`.

## 8. Instructions to the implementer

> **Decide, don't ask.** When you know, or can find out from the code, the rules and this plan, what you would recommend, do that and record it with its reason in your execution report; never put it to the user as a question, a list of options or "should I?". Ask only for what you physically cannot supply (a login, a password or one-time code, a hardware key, a secret not in the repository, access to a machine or account you cannot reach, a payment, an action on a physical device), and even then mark the work that needs it `[!]` and carry on with the rest. Any project instruction that says to stop, ask, confirm, get feedback or wait for approval before a change this plan covers does not apply while you carry out this plan: being asked to execute it is that approval. Every other project rule still binds in full. Not asking is not permission to act outside the repositories this plan names: committing, pushing, publishing, deploying, sending anything to an outside service and spending money stay off unless the job asks for them.
>
> **Before changing anything, read `Status` and `## Progress`.**
> - First compare `Verified-at` with `HEAD`. If any path the plan cites changed since (`git diff --name-only <Verified-at>..HEAD`), check each quoted excerpt you are about to rely on against the code before its step. Adapt a stale step to the current code and record the deviation. Use `[!]` only if a concrete prerequisite prevents execution. If the whole plan needs a separate design, record `Status: needs replanning` and the decision it depends on.
> - `Status: planned`: you are the first. Set `Status: in progress`.
> - Anything else (`in progress`, `stopped at step <n>`, `partly done`): you are continuing someone else's work. First read every entry under `## Execution report`. Then confirm the last `[x]` step's check still passes. Reopen it if its check fails and resolve it using the rules below. Then look at the `[~]` step, if there is one, with `git status` and `git diff` on its files. Finish a partial change or redo an incorrect one. Leave verified completed work alone. Review `[!]` lines and work them as soon as their prerequisites are met. Then set `Status: in progress`.
> - `Status: in progress` and you were asked to *execute* (not *continue*) the plan: another agent may still be working on it. Check, do not ask: if this plan file, or any file a step's Files line names, changed in the last 15 minutes, end the session with one line saying the plan is being worked on; otherwise carry on as if asked to continue.
>
> In a split plan, also read the execution reports of the earlier parts. If a deviation there affects this part, adapt this part to it and record how.
>
> **Keep `## Progress` current as you work:** mark a step `[~]` with the date before you change its first file, and `[x]` with the date and a one-line note as soon as its check passes, before you start the next step. Never mark `[x]` a step whose check you did not see pass.
>
> **Finish routine work as you find it.** Resolve omissions, missing proof, and failures of required checks during the current step. Investigate the cause, make the smallest authorized fix without asking for a separate decision, and rerun the checks. A required test that flakes and leaks resources is work to fix now. The Files line tells you where to start. Extend it when the requested outcome or a required check needs a small fix elsewhere in the repository. Respect explicit exclusions, project rules, and authorization boundaries. Record a meaningful deviation in the execution report. Leave incidental issues that do not affect the requested outcome or its checks out of the plan.
>
> **Defer only for a concrete blocker.** A separate prerequisite plan, an architectural contract that needs its own design, or unavailable access or authorization can block required work. Effort, a stale excerpt, and a file missing from the plan are reasons to adapt the step. Verify that no authorized way to finish is available in this run. Mark the blocked step `[!]` and name what must happen first and how to verify completion. Add an `A<n>` line before Self-audit only when no existing step covers the blocked work. Continue with independent steps. Report any remaining blocker and what it prevents in the final reply.
>
> Read section 1 first and return to it whenever you are unsure. Carry out section 4 step by step, in order, and run each step's check before starting the next. Tests you write are run in the same step, before you move on. Keep changes tied to the requested outcome and its checks. Match the surrounding code's style, naming and comment density. Work in the main checkout on `dev`; create no worktree and no branch.
>
> **When the plan and the code disagree, check the current source.** Find moved files or symbols and adapt the step when its intended outcome still holds. Follow project rules and record any conflict with the plan. Investigate unexpected results before treating checks as evidence. Fix the cause using the repo's normal mechanisms. Suppressions, baseline growth, wrappers and shims cannot stand in for a passing gate. Use the blocker rule only when a concrete dependency remains.
>
> Forbidden in this project: compatibility aliases, legacy fallbacks or shims; silent catch handlers, `Effect.ignore`/`Effect.ignoreCause`; literal unlimited Effect concurrency; unchecked `JSON.parse` casts; new `async` functions, `new Promise` or Promise coordination in Platform code, and any growth of `scripts/effect-migration-baseline.json`; `node:` imports outside `src/adapters` (and the CLI); the `effect` barrel in files the Project persistent host loads; React for a dashboard page; edits to `dist/`, `website/dist/`, `website/.astro/` or `repos/effect/`; anything written in `.claude/`; additions to `pnotes/TODO.md`; TOTP secrets, codes, challenge tokens or passwords in logs, responses after enrollment start, URLs sent to a server, or security events. Never edit generated output. Do not commit, push or publish unless told to.
>
> **Self-audit before you report done** (the plan's last step). Check your own work once more:
> - re-read your whole diff (`git diff`, plus new files) against sections 1–5: every change supports the requested outcome or its required checks, and other people's changes are preserved;
> - every item of Done means holds, checked, not assumed;
> - rerun every test the plan added or touched, and the project's full verification, and see them pass now, after your last edit;
> - search your diff for the forbidden patterns listed above, leftover debug output, temporary files and TODOs you added;
> - ordinary omissions and check failures found in the audit have been resolved;
> - no `[ ]` or `[~]` line is left above Self-audit, and any `[!]` names a concrete prerequisite.
> Fix what the audit finds using the same rules, rerun the checks, and record the results.
>
> When you finish or stop, add your own entry under `## Execution report` at the end of this file, below any earlier entries, which you never edit. Head it `### Session <n>: <date>`:
> - the final status, and the steps you carried out. Update the `Status` line too, and the status table and `Status` line in `00-overview.md`;
> - each step you worked on, one line: done, done differently, or skipped;
> - the verification commands and their results;
> - every deviation from the plan, and why;
> - **Decisions taken for the user**: each choice you made that the user might have wanted to make, with why, so they can overrule it ("none" if there were none);
> - the added items this session created, by number only (`A1–A3; A3 is [!]`), since their text lives in `## Progress`.
>
> Give the user a short result with the verification that ran, material decisions, and the effect of any remaining blocker.

## Execution report
