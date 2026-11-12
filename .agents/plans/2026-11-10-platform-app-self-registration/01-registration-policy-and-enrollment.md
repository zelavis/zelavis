# Shared registration policy and enrollment

Job: Let the owner open signup on the Platform and in individual Zelavis App runtimes.
Date: 2026-11-10
Status: complete
Verified-at: f30953612f
Part: 1 of 5. Read 00-overview.md first.
To start:    Execute the plan in .agents/plans/2026-11-10-platform-app-self-registration/01-registration-policy-and-enrollment.md. Start with its section 8.
To continue: Continue the plan in .agents/plans/2026-11-10-platform-app-self-registration/01-registration-policy-and-enrollment.md. Start with its section 8.

## Progress

- [x] 1. Verify the starting identity and parity suites.
- [x] 2. Persist runtime registration policy and recoverable enrollment.
- [x] 3. Use the policy in password and OAuth account creation.
- [x] 4. Expose registration policy through HTTP, SDK and CLI in both scopes.
- [x] 5. Document the auth behavior and verify both runtime roles.
- [x] 6. Self-audit.

## 0. Summary and finish line

One native Identity policy controls new accounts for each runtime. Ship the headless operations, persistent setting, safe enrollment and sessions. Dashboard controls, human access edits and public App ingress have their own parts.

- **In scope** — registration policy, first-owner gate, password and first-time OAuth enrollment, default user roles, persistence, and public status and administrator operations.
- **Out of scope** — billing, email ownership verification, policy UI and changes to the generic principal model.
- **Done means** — independent Platform and two-App policies, durable transitions, authorized updates, safe retries, and JS, HTTP and CLI parity pass their focused tests and `pnpm run verify`.
- **Supplement** — `.agents/references/plan-writer.md` corrected the cwd of focused parity tests. Existing build baseline passed eight relevant test files. Rebuild before relying on them.
- **Sources read** — `AGENTS.md:345`, `:957`, `:980`, `:1701`, `:1887`, core-platform skill, TigerStyle and Effect v4 references, `repos/effect/LLMS.md`, Effect Schema and Semaphore source, and code cited below.

## 1. Context packet

**Glossary.** Runtime means the Platform or one native App, including a managed recipe's private App integration. A registration policy is local to that runtime. A prepared credential is a provider's validated identifier and secret hash or external subject, ready to store. An enrollment slot is a bounded recovery record reserved by Identity. A principal is resolved from an issued session by the existing authenticator.

> “Identity guarantees hold under concurrency, so they live in the repository, not in a check made first.” `AGENTS.md` § Core Access-Control Rule.
>
> “Use `Effect.fn`/`Effect.gen`, explicit failure channels, scoped finalizers, and bounded Effect concurrency.” `AGENTS.md` § Effect Version & Local Reference Source.

**System today.**

- `packages/zelavis/src/app/identity/identity-service.ts:346` includes signup only when `options.authority !== "platform" && options.registration`. At `:371` it writes an account, credential and session separately. At `:408` the failure path deletes the account alone. Move orchestration into Identity, and preserve public result and cookie adaptation.
- `packages/zelavis/src/app/app-service.ts:116` composes App Identity from its own DB. `:134` defaults `registration` to true. `packages/zelavis/src/index.ts:1605` composes Platform Identity from the System Store and supplies the existing first-owner capability at `:1671`.
- `packages/zelavis/src/app/identity/services/authentication-service.ts:183` consumes OAuth state before exchange, branches to existing credentials at `:254`, and auto-creates an account at `:259`. This is a second existing first-account entry point. Its authorized linking branch starts at `:227`.
- `packages/zelavis/src/platform/auth-bootstrap.ts:18` defines the first-owner claim record. `:155` exposes setup status and `:226` writes the owner. Setup continues to use its own token and role contract.
- `packages/zelavis/src/app/identity/contracts/repositories.ts:12` defines `Mutation<T>`. `packages/zelavis/src/app/identity/storage/database.ts:147` supplies CAS-backed document mutation and `:269` builds App repositories. `packages/zelavis/src/platform/auth-repositories.ts:118` uses System Store conditional mutations. `packages/zelavis/src/app/identity/storage/in-memory.ts:55` mirrors repository semantics for memory composition.
- `packages/zelavis/src/app/identity/providers/password.ts:105` delegates password rules to `hashPassword`. `packages/zelavis/src/app/identity/identity-service.ts:107` sets cookies only for same-origin browser calls. `packages/zelavis/src/app/identity/services/security-service.ts:74` uses an identifier-specific login throttle. Keep registration admission separate so it cannot block a user's login.
- `packages/zelavis/src/platform/project-gateway.ts:649` has the broad authenticated runtime proxy. Its write routes require `project.runtime.manage`. Use the existing `createProjectForwarder` at `:649` to add explicit Project settings routes with their own exact permission, while retaining signed child authority and placement checks.

**Pattern to mirror.** Existing bootstrap uses a durable claim and cleanup around independent account and credential stores. Its `packages/zelavis/src/platform/auth-bootstrap.ts:219` allocates IDs before persistence. Identity accounts and sessions already use atomic compare-and-mutate rather than a read followed by an unconditional write. Reuse those contracts and require the same three backends in `packages/zelavis/test/identity-atomicity.test.mjs:14`.

**Traps.** A process-local boolean loses policy on restart. Mount-time conditional routes cannot reflect a live settings change. Waiting for a request to finish after a disable lets stale authority leak unless commit compares the policy revision. OAuth login can create a new identity. One SQL transaction cannot cover both repository families. An App's user account belongs in its App DB.

## 2. Design

### Authority and persistence

The handler derives Platform or Project authority from composition. Policy updates require `system.settings.manage` with system scope, or `project.settings.manage` scoped to the exact child Project. Public enrollment gets only the role chosen by the runtime and empty permissions/grants. The first owner remains the existing bootstrap capability's responsibility. A Platform runtime needs bootstrap completed before public admission. Use the existing bootstrap status from trusted composition. Prefer an exact read of its completed claim on normal persisted installs when adding the **NEW** `isComplete()` method to `IdentityBootstrapCapability`. An embedded runtime without the durable claim uses its existing completed-account lookup restricted to a verified bootstrap owner with the `owner` role and wildcard permission. Avoid adding another setup record.

Store policy and slots in one repository record so disable and account commit have one ordering. Platform stores it under `zelavis.platform.auth` key `registration`. App stores it in `auth_registration`, document `registration`, in the same `service:zelavis-auth` Tenant as its identity records. Memory uses the existing repository override factory with one per-identity record. A custom durable repository must provide the conditional registration record as part of its enrollment contract. Avoid storing registration policy beside OAuth secrets or in a parent Project metadata row.

### Invariants and interruption

1. A missing record has `{ enabled: initiallyEnabled, revision: 0 }`, with `initiallyEnabled` defaulting to false for both roles. The existing `IdentityServiceOptions.registration` is an explicit initial seed. Persisted policy has precedence. Remove the mount condition and the implicit `?? true` from App composition.
2. Reserve at most eight slots and count at most 60 accepted enrollment attempts per UTC minute per runtime. Reserve before expensive password preparation. A durable fixed window, CAS and an immediate admission limit give bounded work without a growing IP or identifier map. Retry after the next minute when the rate is exhausted and after one second when slots are busy. A crash consumes the original attempt. The existing login limiter remains independent.
3. Reserve IDs before writes. Create an account with `registrationPending: true` and a credential using repository uniqueness. Commit the slot with the original policy revision and enabled state still valid, then clear the account marker with `AccountRepository.mutate`. Verify the exact credential links to the pending account. Login, OAuth linking, session issuance and administrative changes refuse a pending account. A committed slot is irrevocable. Session issuance is after activation. If issuing a session fails, the valid account can sign in with its credential on retry.
4. On a normal precommit failure, delete the credential if owned by that exact account, then delete only that pending account. Remove the slot after cleanup succeeds. If the commit result is ambiguous, reread the slot before compensating. On recovery after previous-writer fencing, roll back reserved slots and complete committed slots from the stored IDs. Do at most eight repairs before opening enrollment. A repair failure keeps public enrollment unavailable and exposes a redacted failure, while existing sessions and owner recovery remain usable. Retire a finished slot only after its account and credential outcome is confirmed.
5. Check bootstrap before Platform admission. OAuth still consumes state, verifies identity and lets an already linked user sign in while closed. Only the new-account branch uses the enrollment service. A policy revision change after reservation and before commit aborts account creation. Linked identities and explicit account administration remain independent operations.
6. Use the existing typed password and provider contracts. Strip privilege-bearing public input before invoking provider preparation, and map only allowlisted account identity fields into the new account. Existing sign-in provider facades are for authenticating existing accounts. Direct auto-provision through `CredentialProviderApi.accounts.create` during public authentication is refused with `enrollment_required`. A provider enrolling new users uses the existing `prepareCredential` or Authorization Code hook. Trusted plugin composition still has its operator-provided API.

Use the existing body reader at `packages/zelavis/src/core/runtime/request-dispatcher.ts:391`. Add **NEW** optional `maxRequestBodyBytes` to `ZelavisServerRoute` at `packages/zelavis/src/core/runtime/contracts.ts:176` and use it at `request-dispatcher.ts:868` after authorization. Set 8192 on signup and 1024 on registration settings PUT. Retain the current default on other routes. Provider string fields are bounded before hashing. Password length remains the existing `hashPassword` policy.

### Decisions, removals and needs

Default off is deliberate even for a Project previously relying on the implicit default. Save the setting independently in each runtime. The owner can enable registration without a new service or extra credential system. Expose an optimistic revision so a stale dashboard cannot silently revert the operator's last change. Retain the existing public signup result with immediate session issuance. Preserve the distinction between a password account and a verified email address. Needs from the user are none.

## 3. Contracts

**NEW** declarations in `packages/zelavis/src/app/identity/domain/registration.ts` and the existing repository contract. Implement strict Effect Schema decoders for request and stored data. Reject extras for policy writes. Validate the shape and uniqueness of the slot keys, phase and all bounded strings and numbers on read.

```ts
export interface RegistrationSettings {
  readonly enabled: boolean;
  readonly revision: number;
}
export interface SetRegistrationSettingsInput {
  readonly enabled: boolean;
  readonly expectedRevision: number;
}
export interface RegistrationStatus {
  readonly enabled: boolean;
  readonly providers: readonly string[];
}
export interface EnrollmentSlot {
  readonly accountId: string;
  readonly credentialId: string;
  readonly policyRevision: number;
  readonly phase: "reserved" | "committed";
}
export interface RegistrationControl extends RegistrationSettings {
  readonly id: "registration";
  readonly schemaVersion: 1;
  readonly windowStartMs: number;
  readonly windowAttempts: number;
  readonly slots: readonly EnrollmentSlot[];
}
export interface IdentityRegistrationRepository {
  read(): Promise<RegistrationControl | null>;
  mutate(mutation: Mutation<RegistrationControl>): Promise<RegistrationControl | null>;
}
export interface RegistrationServiceOptions {
  readonly authority: "platform" | "project";
  readonly initiallyEnabled: boolean;
  readonly enrollmentReady: () => Promise<boolean>;
  readonly now: () => Date;
}
```

Revision is a nonnegative safe integer. Successful changed settings increment it once. Same value with a current revision is idempotent. Slot IDs are server-generated account/credential IDs of at most 96 characters and unique within the eight slots. `windowStartMs` is epoch milliseconds rounded down to a UTC minute. `windowAttempts` is 0–60. All identities reuse existing account/credential/session records. Add optional internal `Account.registrationPending?: true` in `packages/zelavis/src/app/identity/domain/entities.ts:3` and exclude pending records and the marker from the HTTP account list. Public status exposes effective availability and sorted eligible credential enrollment providers, with an empty list when unavailable.

**NEW** errors use the existing Auth error adapter at `packages/zelavis/src/app/identity/identity-service.ts:50`. Payload shape is `{ error: string, code: string }`. The SDK retains the HTTP response in `ZelavisClientHttpError` at `packages/zelavis/src/sdk/fetch.ts:3150`. The CLI emits its existing failure and exits nonzero.

| Error tag | HTTP | Code and meaning |
| --- | --- | --- |
| `RegistrationClosed` | 403 | `registration_closed` for disabled or unready bootstrap |
| `RegistrationSettingsConflict` | 409 | `registration_settings_conflict` for stale revision |
| `RegistrationConflict` | 409 | `registration_conflict` with generic text for uniqueness refusal |
| `RegistrationBusy` | 429 | `registration_busy` plus `Retry-After: 1` |
| Existing `AuthRateLimitError` | 429 | `registration_rate_limited` plus `Retry-After` |
| `RegistrationUnavailable` | 503 | `registration_unavailable` for inconsistent state, unavailable repository or session after successful account commit |
| Existing `IdentityValidationError`, `IdentityNotFoundError` | 400, 404 | `invalid_registration`, `provider_not_found` for malformed requests and unavailable enrollment provider |

| Route ID and path relative to configured API root | Access | SDK and CLI |
| --- | --- | --- |
| **NEW** `auth.registration.status`, `GET /auth/registration` | Public, no-store | `auth.registrationStatus(): Promise<RegistrationStatus>`, `zelavis auth registration-status --json` |
| **NEW** `auth.registration.settings.get`, `GET /auth/registration/settings` | Runtime settings permission | `auth.admin.registrationSettings(): Promise<RegistrationSettings>`, `zelavis auth registration-settings --json` |
| **NEW** `auth.registration.settings.set`, `PUT /auth/registration/settings` | Runtime settings permission | `auth.admin.setRegistrationSettings(input: SetRegistrationSettingsInput): Promise<RegistrationSettings>`, `zelavis auth set-registration-settings --data JSON --json` |
| **NEW** `runtime.projects.auth.registration.settings.get`, `GET /runtime/projects/:projectId/auth/registration/settings` | `project.settings.manage`, exact Project | `projects.registrationSettings(projectId: string): Promise<RegistrationSettings>`, `zelavis projects registration-settings PROJECT --json` |
| **NEW** `runtime.projects.auth.registration.settings.set`, `PUT /runtime/projects/:projectId/auth/registration/settings` | Same exact Project permission | `projects.setRegistrationSettings(projectId: string, input: SetRegistrationSettingsInput): Promise<RegistrationSettings>`, `zelavis projects set-registration-settings PROJECT --data JSON --json` |
| Existing `auth.registration.create`, `POST /auth/sign-up/:provider` | Public, policy checked per commit | Existing `auth.signUp` and `signUpWithPassword`, `zelavis auth sign-up PROVIDER --data JSON --json` |

Signup success is `201` with existing `ZelavisAuthSessionResult` shape and same-origin cookie behavior. Password signup accepts `identifier` 1–254 normalized characters, `password` per existing password policy, optional `displayName` 1–120 trimmed characters. SDK generic provider enrollment keeps bounded provider-specific fields, including names, subject and secret material controlled by the provider. Reject public `id`, `roles`, `permissions`, `grants`, `tenantId`, `verified`, `metadata`, `registrationPending`, and scope/Project fields. Success, status and settings responses are `Cache-Control: no-store`. The Project settings forwarder signs only the exact child settings authority and forwards a fixed relative path. Keep a trusted internal provider prepare callback under the admitted slot. `RegistrationService.settings`, `.setSettings`, `.status`, `.signUp` and `.enrollPrepared` are the domain entry points. Construct the service once in `createIdentity`, with the configured options and repository handles. `status` derives effective readiness plus provider eligibility. `enrollPrepared` is the verified OAuth subject path. Registration recovery runs after writer ownership is established. Existing account/password/session operations keep their normal transports.

## 4. Execution steps

### 1. Verify the starting identity and parity suites

**Files** `packages/zelavis/package.json:162`, `packages/zelavis/test/capability-parity.test.mjs:69`, `packages/zelavis/test/app-auth-service.test.mjs:234` and `packages/zelavis/test/identity-atomicity.test.mjs:14`.

**Change** Establish a clean baseline. Capture `git status --short`, rebuild once, run the existing focused suites from the package cwd through pnpm. Preserve any unrelated worktree edits and avoid concurrent rebuilds of `dist/`.

**Check** From root, `pnpm --filter zelavis run build`, then `pnpm --filter zelavis exec node --test test/{app-auth-service,core-password-auth,auth-oauth-connections,auth-oauth-oidc-flow,platform-auth-parity,identity-atomicity,capability-parity}.test.mjs`. Each command exits zero.

### 2. Persist runtime registration policy and recoverable enrollment

**Files** **NEW** `packages/zelavis/src/app/identity/domain/registration.ts`, `packages/zelavis/src/app/identity/services/registration-service.ts`; `packages/zelavis/src/app/identity/{contracts/repositories,domain/entities,core/types,core/create-identity,services/session-service,core/session-authenticator,services/account-service,storage/in-memory,storage/database,index}.ts`; `packages/zelavis/src/platform/auth-repositories.ts`; **NEW** `packages/zelavis/test/identity-registration.test.mjs`.

**Change** Export the wire types and Schema decoders. Add `IdentityApi.registration` composed once in `createIdentity` with the native repositories, configured authority, clock, and existing Platform bootstrap readiness callback. Add `read`, CAS `mutate`, bounded recovery and reservation/commit semantics from sections 2–3. Initialize and recover only when this runtime owns its writable state. Use `AccountRepository.mutate` to finalize the exact pending account and use existing `delete` methods for compensation. Keep pending accounts invisible and refuse their sessions. Use `AccountService.create` for verified normalization and uniqueness rather than raw records. The record decoder and repository tests cover missing defaults, malformed state, contention and recovery.

**Imports** New contract file `import { Schema } from "effect";`. Service `import { Effect, Schema } from "effect";`, `import { present, integration, integrationValue, unwrapFailure, type IntegrationFailure } from "../../../core/runtime/effect-boundary.js";`, `import type { IdentityRepositories } from "../contracts/repositories.js";`, `import type { Account, Credential, IssuedSession } from "../domain/entities.js";`, `import type { PreparedCredential } from "../contracts/credential-provider.js";`, `import { IdentityConflictError, AuthRateLimitError } from "../core/errors.js";`, and import `RegistrationControl`, `RegistrationSettings`, `SetRegistrationSettingsInput`, `RegistrationStatus`, `EnrollmentSlot` and their codecs from `../domain/registration.js`. `contracts/repositories.ts` adds `import type { RegistrationControl } from "../domain/registration.js";`. Use corresponding local relative registration imports in the three repository factories. `core/create-identity.ts` adds `import { RegistrationService } from "../services/registration-service.js";`, and `core/types.ts` adds its type import. Reuse `Effect` and integration imports in changed Identity files. Test uses `import assert from "node:assert/strict";`, `import test from "node:test";` and the same backend imports as `identity-atomicity.test.mjs:4–11`.

**Depends on** 1.

**Check** `pnpm --filter zelavis run build` then `pnpm --filter zelavis exec node --test test/{identity-atomicity,identity-registration}.test.mjs` from root. Exit zero.

### 3. Use the policy in password and OAuth account creation

**Files** `packages/zelavis/src/app/identity/identity-service.ts:346`, `packages/zelavis/src/app/identity/services/authentication-service.ts:183`, `packages/zelavis/src/app/identity/core/{create-identity,types}.ts`, `packages/zelavis/src/app/app-service.ts:116`, `packages/zelavis/src/platform/auth-bootstrap.ts:155`, `packages/zelavis/src/index.ts:1605`, `packages/zelavis/src/core/runtime/{contracts,request-dispatcher}.ts`; the registration and OAuth test files in sections 4 and 5.

**Change** Compose Platform and Project registration authorities once. Add the Platform readiness callback over its existing bootstrap capability, leaving bootstrap enrollment and owner permissions untouched. Add `registration` as a `RegistrationService` option to `AuthenticationService` and route its first OAuth account plus credential creation through it. Reuse the existing registered and link branches. Replace the conditional spread in `defineAuthEndpointGroup` with an always declared `auth.registration.create` whose handler delegates to `registration.signUp` and builds the existing safe result. Constrain the public login provider facade to existing identities. Route spec advertises the actual refusal statuses. Tighten request size at the shared parser, before any hash. Enrollment and existing login return the established cookie and bearer types.

**Imports** In `identity-service.ts` and `authentication-service.ts` use the new registration service and contract types from `./services/registration-service.js` and `./registration-service.js`, respectively, with existing Effect and error imports. In `src/index.ts`, add the `IdentityBootstrapCapability` type to the existing `./app/identity/index.js` import when wiring the existing bootstrap instance. Add `RegistrationStatus` and settings imports from `./domain/registration.js` in `identity-service.ts`. The dispatcher already imports the route contract and Effect.

**Depends on** 2.

**Check** `pnpm --filter zelavis run build` then `pnpm --filter zelavis exec node --test test/{identity-registration,core-password-auth,app-auth-service,auth-oauth-connections,auth-oauth-oidc-flow}.test.mjs` from root. Exit zero.

### 4. Expose registration policy through HTTP, SDK and CLI in both scopes

**Files** `packages/zelavis/src/app/identity/identity-service.ts:212`, `packages/zelavis/src/platform/project-gateway.ts:649`, `packages/zelavis/src/sdk/fetch.ts:341`, `:1548`, `:2215` and `:2984`, `packages/zelavis/src/cli/{auth-operations,commands,projects}.ts`, `packages/zelavis/test/{capability-parity,platform-auth-parity,platform-project-gateway}.test.mjs`.

**Change** Add the three native status/settings routes with schemas and the two exact management forwarders before broad proxy fallback. The Project writes use scoped `project.settings.manage` and only forward `/auth/registration/settings` through the established child API base and signer. Add typed SDK methods, CLI dispatch and help text. Mirror command config in `auth-operations.ts:10` and use the scoped Project request encoders already in `sdk/fetch.ts:2956`. Update parity recording and actual contract fixtures. A stale write conflicts, and a cross-Project request refuses before child forwarding.

**Imports** SDK `import type { RegistrationSettings, RegistrationStatus, SetRegistrationSettingsInput } from "../app/identity/domain/registration.js";`. Endpoint module imports corresponding schemas and types as above. CLI calls the typed client with the existing JSON body/argument helper. Gateway uses its existing `createProjectForwarder`, `present`, `Effect` and `integration`. Test `platform-auth-parity.test.mjs:5–7` already imports `runAuthCommand`, `outcome` and `platform`. Extend that fixture. For Project CLI coverage use `import { runProjectsCommand } from "../dist/cli/projects.js";` with the existing platform test helpers.

**Depends on** 3.

**Check** Rebuild, then `pnpm --filter zelavis exec node --test test/{identity-registration,platform-auth-parity,platform-project-gateway,capability-parity}.test.mjs` from root. Exit zero. A new route needs real SDK and CLI coverage.

### 5. Document the auth behavior and verify both runtime roles

**Files** docs in section 6; `packages/zelavis/test/identity-registration.test.mjs`.

**Change** Prove the same login identifier can be owned by the Platform and two different Apps. Exercise real stores, distinct policies, restart and subsequent signin. Document the new default and toggle semantics before describing the feature as available. Document account roles and explicit lack of implicit grants.

**Imports** Use `import { Zelavis, createMemorySystemStore } from "../dist/index.js";` and `import { nodeAdapter } from "../dist/adapters/node.js";` in the integration tests. Reuse `node:fs/promises`, `node:os` and `node:path` temporary directory setup from `packages/zelavis/test/services-runtime.test.mjs:1–16`. Docs require no imports.

**Depends on** 4.

**Check** `pnpm --filter zelavis exec node --test test/identity-registration.test.mjs` and `pnpm run docs:check`. Both exit zero.

### 6. Self-audit

Read the diff against sections 0–5, confirm the owner claim stays unique and independent, and rerun section 7. Keep a record of proof for both runtime roles.

## 5. Tests

- **Default and scope.** Arrange a fresh Platform and two Projects. Act through status, unauthorized updates and bootstrap. Assert signup remains closed before bootstrap and until enabled. Enable Project A through its exact scoped parent route. Assert Project B and Platform are still closed. Restart A and read the persisted revision.
- **Access and parity.** Arrange an owner, user, exact scoped settings delegate and sibling delegate. Execute the same GET, PUT, stale PUT and signup through HTTP, SDK and CLI using `platform-auth-parity.test.mjs:11`. Assert equivalent status/body or mapped errors, and zero child forwarding on a scope denial.
- **Passwords and duplicates.** Arrange enabled registration. Submit a valid email, a username, a privilege-bearing body, and concurrent case variants of the same identifier. Assert one committed account and credential for the duplicate, `409` generic refusal, `400` for fields outside the contract, expected fixed role and no grants, and sign-in after disable.
- **OAuth.** Arrange a configured fake provider through the existing OAuth fixture. Start an unknown-subject flow, disable before its callback, assert `403`, state consumed and no new account. Existing linked account and authorized linking continue. Enable and repeat unknown-subject flow. Assert the same safe role and no implicit grants.
- **Fault injection.** With each of the three `identity-atomicity` backends, fail after reservation, account create, credential create, slot commit, activation and session issuance. Interrupt and recreate the runtime at each boundary, then inspect exact IDs. Assert precommit cleanup, postcommit activation, no session accepted for pending accounts, and no credential orphan. Inject corrupt stored state and assert enrollment refuses while existing login is available. Race disable against commit and prove exactly the ordered outcomes. Include ambiguous store results and conditional cleanup retry.
- **Bounds.** Hold eight admitted attempts, assert the ninth returns `429`; exhaust the 60-attempt window and assert `Retry-After` and reset on the next minute. Send over-limit chunked input and assert `413` before provider execution. Keep an existing login usable while registration is limited. For the staged enrollment state machine, compare seeded runs against a small reserve/commit/recover model and print the seed on failure.

## 6. Docs and project notes

Update `website/src/content/docs/{packages/auth.md,packages/app.md,api/platform-operations.md,architecture/access-control.md}`, and `packages/zelavis/README.md`. List default closed, initial config seed and saved-policy precedence, signup versus sign-in, OAuth admission and the Project CLI/API/SDK commands. Add a concise changeset for `zelavis`. Check `pnotes/TODO.md:464` for open verification, recovery and MFA work. Update only entries whose state changes.

## 7. Verification

From root, build once before focused tests. Run `pnpm --filter zelavis exec node --test test/{identity-registration,identity-atomicity,core-password-auth,app-auth-service,auth-oauth-connections,auth-oauth-oidc-flow,platform-auth-parity,platform-project-gateway,capability-parity}.test.mjs`, `pnpm run docs:check`, `pnpm run verify`, and `git diff --check`. All exit zero. UI qualification belongs to Parts 3–5.

## 8. Instructions to the implementer

Read Status, Progress and the overview before editing. Compare `Verified-at` with current HEAD and check cited paths against uncommitted changes. Recheck the Effect 4.0.0 source, `AGENTS.md` and the core platform skill. Mark each step `[~]` before edits and `[x]` only after its check passes. On continuation, read earlier execution reports and rerun the most recent completed check. A fresh edit in an `in progress` plan may belong to another active implementer. When asked to execute rather than continue, leave it to that session if edited in the past 15 minutes.

Decide routine details from the existing code and record meaningful deviations. Resolve required failures in the current step. Use `[!]` only for an unavailable concrete prerequisite, name its verification, and continue independent work. Reuse typed failures, bounded Effect orchestration and conditional writes. Avoid compatibility aliases, Promise orchestration, silent catches, unchecked parse casts, generated-file edits and baseline growth. Self-audit the entire diff and rerun all relevant gates after the last edit. Keep publishing and commits separate. Update the overview status and append a dated execution report with checks and deviations when stopping.

## Execution report

### 2026-11-11

Part 1 complete. The working baseline matched `f30953612f`, and the 66 starting identity and parity tests passed after a rebuild.

- Persisted per-runtime registration control in memory, the Platform System Store and the App database. Exercised every staged enrollment boundary, ambiguous commit, compensation retry, bounded admission, and malformed stored state.
- Routed password signup and first-time OAuth through native enrollment. Reused the Platform's completed bootstrap claim and preserved existing sign-in and authorized OAuth linking.
- Added the native and exact Project settings operations through HTTP, SDK and CLI. The gateway signs only the named Project's settings permission. Updated the route inventory and verified that settings requests reach the child runtime.
- Used a Node Platform and two native App processes to prove independent settings, account ownership, session isolation and restart persistence. Verified the Platform's same-origin signup cookie. Public App ingress and issuer-specific cookies are part 4.
- Bound enrollment readiness to the existing bootstrap capability at endpoint composition. Embedded service recomposition shares one recovery pass with its current writer and keeps the default memory System Store for the lifetime of the embedded runtime. Tested a signup held across recomposition with both supplied and default stores.
- Passed the final rebuild, 144 focused tests, `pnpm run verify`, `pnpm run docs:check`, and whitespace checks. Updated the public docs, changeset and private project notes.
