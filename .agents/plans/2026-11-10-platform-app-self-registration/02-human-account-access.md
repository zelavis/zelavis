# Human account roles and scoped Project access

Job: Give the Platform owner a user and customer access foundation backed by existing roles and grants.
Date: 2026-11-10
Status: complete
Verified-at: f30953612f
Part: 2 of 5. Read 00-overview.md first.
To start:    Execute the plan in .agents/plans/2026-11-10-platform-app-self-registration/02-human-account-access.md. Start with its section 8.
To continue: Continue the plan in .agents/plans/2026-11-10-platform-app-self-registration/02-human-account-access.md. Start with its section 8.

## Progress

- [x] 1. Add conditional human account access changes.
- [x] 2. Enforce delegation at Auth endpoints and add SDK and CLI parity.
- [x] 3. Return the Projects the signed-in principal can see.
- [x] 4. Document delegation and verify authorization.
- [x] 5. Self-audit.

## 0. Summary and finish line

New customers and App users from Part 1 have identities but no grants. Give an authorized operator an atomic access edit and let signed-in customers list only their granted Projects. The existing grants continue to determine which Project actions are allowed.

- **In scope** — fixed human role labels, bounded conditional permission/grant replacement, delegated authority checks, and scoped Project inventory.
- **Out of scope** — custom role hierarchy, organization and reseller lifecycle, account deletion, invites, automatic grant creation and provisioning.
- **Done means** — an owner can assign or revoke access to an existing Project. A customer with zero grants gets an empty list. No cross-Project or global access is inferred from a role. Current sessions are invalidated when access changes.
- **Supplement** — existing checked supplement with focused-test cwd correction. Start after Part 1's gates pass and the `RegistrationService` and default account roles exist.
- **Sources read** — `AGENTS.md:1701`, `:1887`, `:957`, core platform and plan-writer skills, TigerStyle and Effect v4 references, and the code below.

## 1. Context packet

**Glossary.** A role is a label an endpoint may explicitly require. A permission is a named operation capability. A grant ties a permission to an explicit scope. A top-level permission spans scopes. A Project account authenticates to its own runtime. A Platform customer can have scoped permissions on Projects that already exist.

> “Project and service grants require the same explicit route identity and never satisfy an unscoped requirement.” `AGENTS.md` § Core Access-Control Rule.

- `packages/zelavis/src/core/runtime/contracts.ts:20–60` defines scopes, grants and principal. `packages/zelavis/src/core/runtime/request-dispatcher.ts:661` checks top-level and scoped grants. `:691` exposes `principalHasPermission`, which is the predicate to reuse.
- `packages/zelavis/src/app/identity/core/session-authenticator.ts:42` projects stored roles and grants. App account permissions are translated into grants for its own Project. The resolved account is reread on each authentication at `:120`. `packages/zelavis/src/app/identity/services/session-service.ts:62` uses account epoch when creating sessions.
- `packages/zelavis/src/app/identity/services/account-service.ts:8` accepts roles, permissions and grants on account creation. `packages/zelavis/src/app/identity/contracts/repositories.ts:12–29` already has atomic `AccountRepository.mutate`. Existing Auth routes create accounts and credentials and expose service account administration. The new operation must share their delegation protections.
- `packages/zelavis/src/index.ts:6031` requires global `projects.list` and returns `projects.list()` without scoped filtering. `:6235` protects an individual Project with `project.view`. A customer needs the inventory filtered by actual grants rather than a new global permission.
- `packages/zelavis/src/platform/project-gateway.ts:38` translates Platform authority into concrete child permissions. `:114` shows that `project.view` carries backend inspection/read authority. It is an explicit Project visibility and inspection grant. Part 5 adds a separate domain-management permission and does not imply it from view.
- `packages/zelavis/src/adapters/_node-project-engine.ts:127` resolves the signed Gateway principal from concrete permissions and the exact audience. Roles are not transmitted. An App's role edit is limited to `user`; its concrete permissions are scoped to itself.

**Pattern to mirror.** Store the access fields and new session epoch in the same `accounts.mutate` callback. Session revocation already uses epoch comparisons. In the Platform dashboard inventory, mirror the per-Project scope check at `packages/zelavis/src/index.ts:6235`, then fetch by exact ID for scoped callers.

**Traps.** Adding `projects.list` to every customer would expose the full list. Copying role labels into grants would give labels implicit power. Checking only the proposed grants lets a delegate modify a more privileged account. The parent Gateway is a projection boundary with named permissions, and must never forward a wildcard to make delegation work.

## 2. Design

### Authority and state

Use `system.users.manage` with system scope on the Platform and `project.users.manage` with the exact Project scope inside an App. A caller may replace another ordinary human's access only if it can delegate every existing and requested authority. Use `principalHasPermission` with each concrete grant scope. For top-level Platform permission delegation, require that the same permission or `*` is in the actor's top-level permissions, because a system grant cannot authorize a new cross-scope permission. For an App, forbid top-level `permissions` in this write contract and accept only explicit grants for that App's exact ID. The Gateway signs only the actor's actual Project authority. For request-grant enumeration, intersect validated requested concrete permissions with the parent's exact scope and include only the already authorized names. A wildcard is never sent into the App.

`customer` and `user` are default human labels. A Platform role edit can set `customer`, `operator` or `reseller`. Changing an operator/reseller label requires the actor to hold that label or a global wildcard. App humans use `user`. Keep role labels distinct from capabilities. Refuse edits of any owner, service identity, pending account, or the actor's own account. Refuse granting an owner, service or system label, and reject wildcard grants in this API. The first-owner account and token remain with bootstrap.

Add `Account.accessRevision?: number` to `packages/zelavis/src/app/identity/domain/entities.ts:3`. Existing accounts without a recorded edit have revision zero. Replace the access fields and increment revision and `sessionEpoch` in one conditional mutate, with safe-integer bounds. A matching no-op returns current state without rotating sessions. Current or requested grant authority, actor identity, revision and target classification are checked again at the mutation boundary. Use the execution context principal. For locally resolved human admins, refresh their account authority inside the access-write gate immediately before committing an edit. Gateway principals use the verified short-lived audience-bound snapshot. Keep account access edits under a bounded runtime gate and the durable per-target compare-and-mutate, with existing writer fencing. A conflict leaves all fields and sessions as they were. Successful edits record a redacted access event using the existing Identity security repository, with actor ID, target ID and revision only. A failed audit append is reported with the committed revision and the account read remains authoritative.

Existing credential, service-account and account creation endpoints remain accessible to their intended delegates. Apply the same delegability helper on grant-bearing creation paths and protect credentials and token rotation for targets with greater authority. Constrain reserved metadata used by identity (`principalType`, `serviceAccount`, `tenantId`, pending markers) to its dedicated operations. Keep import verification metadata under its existing import contract without granting roles or a service identity. These are necessary authorization boundaries once delegated operators can administer users.

### Project inventory

Change existing `GET /runtime/projects` to require a signed-in principal. Preserve global-list behavior for `projects.list` and a top-level `project.view` or wildcard. Otherwise extract, deduplicate and sort the explicit `project.view` and exact scoped wildcard grants, and read those Project IDs through `projects.view`, with concurrency four. Stop after a validated maximum of 100 distinct Project IDs in scoped API principals. Return an explicit error for a larger unsupported grant set instead of truncating results. Omit deleted/tombstoned Projects from the scoped list. A new customer has no qualifying grants and receives an empty list. Keep individual `GET /runtime/projects/:projectId` and other Project actions protected. Domain grants in Part 5 require a separate exact check.

### Decisions and needs

Use conditional access replacement with three existing role labels on the Platform and the App's `user` label. This provides customer administration without introducing a separate RBAC catalogue or custom inheritance. The UI will say that Project view includes backend inspection when it is assigned. Needs from the user are none.

## 3. Contracts

**NEW** types in `packages/zelavis/src/app/identity/domain/account-access.ts`.

```ts
export type HumanAccountRole = "customer" | "operator" | "reseller" | "user";
export type ConcreteAccountGrant = {
  readonly permission: string;
  readonly scope:
    | { readonly type: "system" }
    | { readonly type: "project"; readonly projectId: string }
    | { readonly type: "service"; readonly serviceName: string };
};
export interface SetAccountAccessInput {
  readonly expectedRevision: number;
  readonly role: HumanAccountRole;
  readonly permissions: readonly string[];
  readonly grants: readonly ConcreteAccountGrant[];
}
export interface AccountAccessResult {
  readonly accountId: string;
  readonly accessRevision: number;
  readonly role: HumanAccountRole;
  readonly permissions: readonly string[];
  readonly grants: readonly ConcreteAccountGrant[];
}
```

Schema uses a strict object. `expectedRevision` is a nonnegative safe integer. Permission names are 1–128 characters of lowercase letters, digits, dot, dash, colon and slash, starting with a letter. Scope IDs are 1–128 characters and valid existing Project or service identifiers. Maximum 100 combined entries. Deduplicate and sort by permission plus exact scope. Reject wildcard entries and route parameter names in persisted scope. Add `accessRevision` to safe administrative account responses. Reject malformed input with `400 invalid_account_access`, unauthorized delegation with `403 account_access_forbidden`, unknown or out-of-scope account with `404 account_not_found`, stale revision with `409 account_access_conflict`. SDK and CLI use existing HTTP error mapping.

| Route relative to configured API base | SDK | CLI |
| --- | --- | --- |
| **NEW** `PUT /auth/accounts/:accountId/access` with `SetAccountAccessInput`, returns `AccountAccessResult` | `auth.admin.setAccountAccess(accountId: string, input: SetAccountAccessInput): Promise<AccountAccessResult>` | `zelavis auth set-account-access ACCOUNT --data JSON --json` |
| **NEW** `PUT /runtime/projects/:projectId/auth/accounts/:accountId/access` with same contract | `projects.setAccountAccess(projectId: string, accountId: string, input: SetAccountAccessInput): Promise<AccountAccessResult>` | `zelavis projects set-account-access PROJECT ACCOUNT --data JSON --json` |
| Existing `GET /runtime/projects` returns existing Projects response for the caller's visible set | Existing `projects.list()` | Existing `zelavis projects list --json` |

## 4. Execution steps

### 1. Add conditional human account access changes

**Files** **NEW** `packages/zelavis/src/app/identity/domain/account-access.ts`; `packages/zelavis/src/app/identity/domain/entities.ts:3`, `services/account-service.ts:20`, `index.ts`; **NEW** `packages/zelavis/test/identity-account-access.test.mjs`.

**Change** Implement strict schemas, `assertCanDelegateAccountAccess` and `AccountService.setAccess`. The service takes a trusted `{ principal, authority, projectId }` context from the endpoint, decodes once, rechecks the target inside `mutate`, and returns the safe result. Store `accessRevision` and the bumped session epoch with the new access fields. Ensure mutation callback is pure. Cover allowed, denied, replayed, stale, concurrently revoked and no-op writes using the same three backends as Part 1.

**Imports** Contract `import { Schema } from "effect";`. Account service adds `import { principalHasPermission } from "../../../core/runtime/request-dispatcher.js";`, `import type { ZelavisPrincipal } from "../../../core/index.js";`, plus contract schemas, errors and types from `../domain/account-access.js`. Test uses the Node assert and test imports and backend factories from `packages/zelavis/test/identity-atomicity.test.mjs:1–11`.

**Check** From root, `pnpm --filter zelavis run build` then `pnpm --filter zelavis exec node --test test/{identity-account-access,identity-atomicity}.test.mjs`. Both exit zero.

### 2. Enforce delegation at Auth endpoints and add SDK and CLI parity

**Files** `packages/zelavis/src/app/identity/identity-service.ts:212`, `:259`, `:303`, `:925` and `:1019`; `packages/zelavis/src/app/identity/account-import.ts:124`, `services/security-service.ts:58`, `domain/entities.ts:73`; `packages/zelavis/src/platform/project-gateway.ts:649`; `packages/zelavis/src/sdk/fetch.ts:363`, `:1548`, `:2984`; `packages/zelavis/src/cli/{auth-operations,commands,projects}.ts`; parity and account tests below.

**Change** Add `auth.accounts.access.set` and `runtime.projects.auth.accounts.access.set`, their schemas and access requirements. Reuse the exact forwarder pattern from Part 1. Deny out-of-scope body authorities and protect existing privileged account, credential and token operations with the same helper. The Auth update returns only access fields. Use the existing identity event store and versioned result to show a committed edit if audit persistence requires repair. Add SDK/CLI operations and parity cases. Keep explicit role and scope tests for the guarded neighboring routes.

**Imports** `identity-service.ts` imports `AccountAccessResult`, the input codec and `assertCanDelegateAccountAccess` from its new domain and account-service modules. `sdk/fetch.ts` adds `import type { AccountAccessResult, SetAccountAccessInput } from "../app/identity/domain/account-access.js";`. CLI and Gateway use their existing imports and helpers, plus the input codec at the body boundary when needed. Tests extend existing `runAuthCommand`, `runProjectsCommand`, `platform` and `outcome` imports from Part 1.

**Depends on** 1.

**Check** Rebuild and run `pnpm --filter zelavis exec node --test test/{identity-account-access,platform-auth-parity,platform-project-gateway,auth-sdk-service-accounts,auth-account-import,capability-parity}.test.mjs` from root. Exit zero.

### 3. Return the Projects the signed-in principal can see

**Files** `packages/zelavis/src/index.ts:6031`, `:6235`, `packages/zelavis/src/project.ts:2319`; **NEW** `packages/zelavis/test/customer-project-access.test.mjs`.

**Change** Adapt `runtime.projects.list` with the scoped inventory contract above. The existing `projects.view` is the non-lifecycle-mutating per-ID read. Resolve only granted IDs for restricted callers, omit unavailable/tombstoned entries, and leave project action checks in their existing handlers. The new test asserts empty inventory for a signed-in new customer, exactly one granted Project after a conditional edit, no other Project details, and correct refusal of global mutations. Existing owner and service-account global inventory keep their authorized results.

**Imports** `src/index.ts` already imports `principalHasPermission`, `Effect` and integration helpers. Test uses `import assert from "node:assert/strict";`, `import test from "node:test";`, `import { platform } from "./_runtime.mjs";` and the runtime setup used by Part 1 when a real session is required.

**Depends on** 2.

**Check** Rebuild and run `pnpm --filter zelavis exec node --test test/{customer-project-access,platform-project-gateway,capability-parity}.test.mjs` from root. Exit zero.

### 4. Document delegation and verify authorization

**Files** `website/src/content/docs/{architecture/access-control.md,api/platform-operations.md,packages/auth.md}`, `packages/zelavis/README.md` and a **NEW** Changeset for `zelavis`.

**Change** Document role labels, exact scope, conditional access edits, invalidated sessions and all transports. Show an explicit Project view grant and document its backend visibility. Mention the planned domain grant only once Part 5 ships. Leave Hosting Provider billing in its own roadmap.

**Depends on** 3.

**Check** `pnpm run docs:check` from root. Exit zero.

### 5. Self-audit

Review every authorization entry point touched and confirm the actor never delegates authority beyond its scope. Rerun section 7 from root after the last edit.

## 5. Tests

- **Grant lifecycle.** Create a customer using Part 1. Assert `projects.list()` gives zero Projects. Owner writes one concrete `project.view` grant. Previous customer token returns `401` after the epoch bump. Re-sign in and see exactly that Project. Remove the grant, re-sign in and confirm the inventory is empty.
- **Delegated scope.** A user with `project.users.manage` and explicit access in App A can assign one held App A grant. The same actor cannot assign App B, a system permission, wildcard or an unheld permission. Test no child invocation on wrong parent Project scope.
- **Protected identities.** Attempt owner, service, self and pending-account edits. Assert denial and unchanged state. Exercise related account/credential/service token authorization and verify an existing authorized operation continues.
- **Concurrency.** Hold two different updates at one account revision. One wins, one returns `409`. Assert epoch advanced once, retries with stale input leave state untouched and a current no-op preserves the session.
- **Parity.** Use existing recording-fetch parity and real runtime tests for valid, stale and denied updates. Verify account secrets stay out of results and audit events. Simulate audit persistence failure and confirm the committed version is visible from the account read.

## 6. Docs and project notes

See step 4. Update the private Identity section at `pnotes/TODO.md:464` only when an existing open item changes. Describe customer domains and hosting entitlements according to their actual shipped state.

## 7. Verification

From root, run `pnpm --filter zelavis run build`, then `pnpm --filter zelavis exec node --test test/{identity-account-access,customer-project-access,identity-atomicity,platform-auth-parity,platform-project-gateway,auth-sdk-service-accounts,auth-account-import,capability-parity}.test.mjs`, `pnpm run docs:check`, `pnpm run verify` and `git diff --check`. All exit zero.

## 8. Instructions to the implementer

Read Status and Progress and verify Part 1's handover. Compare `Verified-at` and the dirty worktree against the paths you touch. Read the core platform skill, `AGENTS.md`, pinned Effect and TigerStyle references. Mark each step `[~]` before editing and `[x]` after its check passes. If continuing, read reports and rerun the last completed check. If asked to execute a recently edited `in progress` plan, leave it to the active session.

Decide routine details in the existing architecture and record deviations. Resolve required failures in the current step. Mark `[!]` only for a concrete unavailable prerequisite and continue independent work. Preserve the existing scoped authority evaluator, repository uniqueness and session epochs. Avoid authorization shortcuts, compatibility aliases, generated edits, Promise orchestration, baseline growth and silent error handling. Rerun gates and record the final result in the overview and a dated execution report. Publishing, deployment and commits are separate work.

## Execution report

### 2026-11-11

Part 2 complete against `f30953612f` with the completed Part 1 in the worktree.

- Added strict conditional account access replacement and redacted security events. Verified epoch invalidation, no-op preservation, contention, bounded admission and protected identities across memory, System Store and Project database repositories.
- Added Platform and exact Project access edits through HTTP, SDK and CLI. Guarded account creation, imports, credential creation, managed session revocation and service-account operations against delegated authority escalation.
- The Gateway reads the named account through an exact filter on the existing accounts list. It signs an account-bound digest of the revision, replacement and authorized permission names. The child verifies that proof before its conditional write. This keeps the full edit within the existing Gateway and Agent transport limits. Verified signed dispatch, worker handover and edits against a running App.
- Verified a registered customer receives an empty inventory, gains visibility into one Project after an owner edit, loses its old session and returns to an empty inventory after revocation. Verified exact wildcard scope, tombstones and the scoped inventory limit.
- Updated the public documentation and added a Zelavis changeset. The final package build, 74 focused tests, `pnpm run docs:check`, `pnpm run verify` and `git diff --check` passed.

Continue with `03-dashboard-registration-controls.md`.
