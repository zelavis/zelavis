# Service principals approved at install
Job: Let an installed service ask for Platform permissions in its manifest, have the operator approve exactly those permissions when installing it, and act with them through an in-process API client; and refuse disabling a service another installed service extends. Hosting (part 14) is the first user; any service can use it.
Date: 2026-11-13
Status: done
Verified-at: 0e4548dbcc (refreshed 2026-11-16 against the Zelavis Auth working tree, before it was committed; line numbers dropped in favour of symbols)
Part: 13 of 14. Read 00-overview.md first.

To start:    Execute part 13 in .agents/plans/2026-11-13-accounts-billing-domain-automation/13-service-principals.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-13-accounts-billing-domain-automation/13-service-principals.md. Start with its section 8.

## Progress

- [x] 1. (2026-11-18) Baseline build and services/runtime/discovery/parity tests passed.
- [x] 2. (2026-11-18) Reverse dependency guard and focused test passed.
- [x] 3. (2026-11-18) Manifest validation, propagation and listing tests passed.
- [x] 4. (2026-11-18) Exact approval, delegation, concurrent ownership, sealing, update and revocation tests; build and Effect check passed.
- [x] 5. (2026-11-18) Own-account/anonymous fetch, startup 503, credential stripping and Project absence tests passed.
- [x] 6. (2026-11-18) Typed SDK and repeatable CLI approvals; 14 principal/parity tests passed.
- [x] 7. (2026-11-18) UI typecheck, 95 unit tests and full ci:ui passed; desktop/mobile approval survives reload.
- [x] 8. (2026-11-18) Service authoring/model, AGENTS and core-platform skill updated; docs check passed.
- [x] 9. (2026-11-18) Self-audit complete; final verify (3,427 Zelavis passes, 30 skips), ci:ui, docs and whitespace gates passed.

## 0. Summary and finish line

A service installed from the Marketplace runs at extension scope (`AGENTS.md § Platform And App Service Boundary`), which is right, but it then has no way to act on the Platform: no in-process API client and no authority of its own. A hosting business needs a service that creates Projects and assigns access to customers. Instead of a special case for Hosting, this part adds one general mechanism, the way a phone asks before an app gets permissions: the manifest names the permissions a service needs (`zelavis.principal.permissions`), the install refuses until the installing operator approves exactly that list (and only permissions the operator holds, as delegation already requires), the Platform then creates a service account for the service and keeps its token sealed, and the service calls Platform operations in-process through `core.fetch` as that account. Disabling the service revokes the account. The part also adds the missing reverse check: a service cannot be disabled while an installed service extends it (Ecommerce while Hosting or a payment plugin is installed).

- **In scope**: manifest field and validation; approval on every install path (acquire, PATCH, update to a listed version); service account creation, sealing and revocation; `core.fetch` for every Platform service; the reverse-dependency refusal; SDK, CLI and Marketplace dialog; docs.
- **Out of scope**: principals for services in Project runtimes (a service declaring one is refused there with `principal_unsupported`; a Project has no Platform authority to give); per-request consent; changing a principal's permissions without reinstalling or updating.
- **Done means**: (a) a manifest with `zelavis.principal.permissions` loads; one with `*`, a malformed permission or more than 30 is refused at load; (b) installing such a service without `approvePermissions` answers 409 `principal_approval_required` listing the permissions, and with a different list 409 again; with the exact list it installs, and a service account named `service:<package name>` exists with those permissions; (c) an operator lacking one of the permissions cannot approve it (403, delegation); (d) the service's `core.fetch` reaches Platform routes as that account and is refused where the account has no permission; a service without a principal gets anonymous `core.fetch`; (e) disabling the service revokes the account's tokens, and reinstalling asks again; an update whose manifest asks for more permissions refuses until approved; (f) disabling a service another installed service extends answers 400 naming the extenders; (g) parity, browser, `verify`, `ci:ui`, `docs:check` pass.
- **Owner decision (2026-11-13, this conversation)**: Hosting is its own service with plans and billing that requires Ecommerce, not part of core and not bundled; this part is the general mechanism that lets such a service act on the Platform through ordinary grants.
- **Supplement**: updated in this run (overview section 0).
- **Refreshed 2026-11-16** (Zelavis Auth plan part 16): the service account is a Zelavis Auth service account (`packages/zelavis/src/auth/serviceAccounts`), created, granted and revoked in one Auth transaction each; disabling a service deletes its account (Auth's `revokeServiceAccount` behavior) instead of keeping it without permissions, and the security events keep the history.
- **Sources read**: `AGENTS.md § Platform And App Service Boundary` (trust scope), `§ Core Access-Control Rule`, `§ Service Loading Rules`, `§ Marketplace Allow-List`, `§ Endpoint-Backed Capability Rule`; files below.

## 1. Context packet

**Glossary.**
- **Service principal**: the service account the Platform creates for one installed service, with exactly the permissions the operator approved.
- **Approval**: the `approvePermissions` list sent with an install, equal as a set to the manifest's request.
- **Extender**: an installed service whose capabilities name another service as owner (`serviceExtensionOwners`).

**Governing rules.**
- R1 > "anything installed or dropped into a services folder is forced to `extension` … the dashboard puts an extension's menus only in the Extensions slide and frames its page without the dashboard's origin." `AGENTS.md § Platform And App Service Boundary`. This part does not change scope; it gives an extension service an explicit, approved identity instead.
- R2 > "Customers, resellers, operators, and owners are Zelavis principals with system, project, or service-scoped grants." `AGENTS.md § Core Access-Control Rule`
- R3 > "Static identity, capabilities, Marketplace and Project recipe metadata belong only in `package.json`." `AGENTS.md § Platform And App Service Boundary` (the request is manifest data).
- R4 > "The version comes from the list, never the request, and installs through the same gate." `AGENTS.md § Marketplace Allow-List` (approval adds to the gate; it never chooses a version).
- R5 > "The agent is not a principal. It borrows the caller's authority." `AGENTS.md § Endpoint-Backed Capability Rule` (Assistant). A service principal is the opposite on purpose: its own, visible, revocable account, never the caller's authority.

**System today.**
- Install paths in `packages/zelavis/src/index.ts`: `POST /runtime/services` (route id `runtime.services.create`, body read by `readDashboardServiceRegistryCreate`); `PATCH /runtime/services/:name` (`runtime.services.update`; its install-time extension check is the `serviceExtensionOwners(` call in that handler); `POST /runtime/services/:name/update` (`runtime.services.updateToListed`). All `system.services.manage`. Find each with `rg -n 'id: "runtime.services.' packages/zelavis/src/index.ts`.
- Dashboard install `packages/zelavis/services/zelavis-ui/app/marketplace-pages.ts` → `installService` (POST with `packageSource` when `installVia === "acquire"`, else PATCH `{ status: "installed" }`) and the `install`/update actions beside it.
- CLI `zelavis services install|enable|disable|uninstall NAME` in `packages/zelavis/src/cli/commands.ts` (`updateRuntimeService(name, { status })`); `zelavis marketplace update NAME` (`packages/zelavis/src/cli/marketplace.ts`). SDK `createServicesClient` (imported by `packages/zelavis/src/sdk/fetch.ts`) and `client.marketplace.update`.
- Manifest validation `packages/zelavis/src/core/service/manifest.ts` → `validatePluginPackageManifest` (capabilities and namespace checks inside it).
- Service accounts (Zelavis Auth, `AGENTS.md § Zelavis Auth`): `packages/zelavis/src/auth/serviceAccounts/serviceAccounts.ts` → `createServiceAccount(tx, { principal, context, name, days, permissions, grants })` (`resolveActor` and `canDelegateAccess` from `auth/access/delegation.ts`, `createAdmittedAccount` with `kind: "service"`, `metadata: { principalType: "service", serviceAccount: true }`, then `issueServiceToken`), `rotateServiceAccountToken`, `revokeServiceAccount` (revokes tokens, deletes the account row, records `service_account.revoked`). Tokens: `auth/serviceAccounts/tokens.ts` (`zvs_` prefix, stored as hashes in `serviceAccounts_tokens`, `SERVICE_TOKEN_MAX_DAYS = 3650`, `resolveServiceToken` read by the request authenticator). Routes `auth.serviceAccounts.*` in `auth/routes/admin.ts`. Every call runs inside `auth.runtime.mutation(request, (tx) => …)` (`auth/runtime/tx.ts` → `AuthRuntime`); the Platform's composed Auth is the `auth` of `createAuthSubsystem` (`auth/subsystem.ts`).
- Setup context `packages/zelavis/src/service.ts` → `ZelavisServiceSetupCoreContext`; runtime fetch `guardedFetch` in `packages/zelavis/src/index.ts`.
- Sealing: `loadPlatformMasterSecret` `packages/zelavis/src/platform/master-secret.ts:19`; `encryptSecret`/`decryptSecret` `packages/zelavis/src/edge/acme-crypto.ts:79`, `:104`.

**Pattern to mirror.** The install-time extension check (the `serviceExtensionOwners(` call in `runtime.services.update`) for where approval is checked; `createServiceAccount` and `revokeServiceAccount` for how an account and token are made and removed (call the Auth module in-process inside `auth.runtime.mutation`, never the HTTP route); the cloud token's sealing in `packages/zelavis/src/platform/cloud-capacity.ts` (`encryptSecret`/`decryptSecret`).

**Traps.**
- Handing the token to the service: the service never sees it. The Platform keeps it sealed and adds the `authorization` header inside `core.fetch`.
- Approving on the service's behalf in code paths that "install defaults": bundled services are system scope and need none; any extension install path without the approval list must refuse.
- Approving more than the operator holds: run the same delegation check `createServiceAccount` runs (`resolveActor` then `canDelegateAccess`), with the installing principal as actor, inside the transaction that writes the account.
- Leaving the account alive after disable: revoke it in the same operation that disables the service; a failed revoke fails the disable.
- Finding the account by display name: names are not unique. Find it through the NEW owner row keyed by package name, read and written in the same transaction.
- Comparing approval as an ordered list: compare as sets.

## 2. Design

**Manifest.** `zelavis.principal?: { permissions: string[] }`: 1-30 strings, each matching the account-access permission pattern `^[a-z][a-z0-9.\-:/]*$` (1-128 characters, `PermissionSchema` in `packages/zelavis/src/auth/access/access.ts`), never `*`, no duplicates. Absent means the service has no principal.

**Approval.** Every install of a service with a principal (POST create with `status: "installed"`, PATCH to `installed`, `updateToListed` when the newer manifest's set is not a subset of the approved one) needs body field `approvePermissions: string[]` equal as a set to the request; otherwise 409 `{ error: "principal_approval_required", permissions: [...] }`. The handler then, before activation, runs NEW `grantServicePrincipal(tx, { principal: installer, context, serviceName, title, permissions })` (`auth/serviceAccounts/servicePrincipals.ts`) in one `auth.runtime.mutation`: (1) `resolveActor` and `canDelegateAccess(actor, context, { permissions, grants: [] })` (403 `account_access_forbidden` on failure); (2) read the NEW `serviceAccounts_owners` row `{ serviceName, accountId }` (index `by_serviceName`); if present, patch that account's permissions to the approved list, else create the account as `createServiceAccount` does, with display name `<marketplace title or package name> (service)` and `metadata.ownerService: <package name>`, and insert the owner row; (3) `revokeServiceTokens` then `issueServiceToken(tx, accountId, SERVICE_TOKEN_MAX_DAYS)`; (4) `recordSecurityEvent` `service_account.principal_granted` naming the installer. The transaction returns the plain token once. The Platform then stores `{ schemaVersion: 1, accountId, permissions, sealed: EncryptedSecret, approvedBy, approvedAt }` at System Store `zelavis.service-principals` / `<package name>`, key purpose `service-principal:<package name>`. If storing fails, the install fails and the retry runs `grantServicePrincipal` again, which rotates the token, so no usable token is left unrecorded.

**Revocation.** PATCH to `available` (CLI `disable`/`uninstall`) runs NEW `retireServicePrincipal(tx, serviceName)` (revoke the tokens, delete the account and its owner row, record `service_account.revoked`) and then deletes the stored record, before deactivation. Reinstalling creates a new account through approval; the security events keep the history.

**In-process fetch.** `ZelavisServiceSetupCoreContext.fetch?: (input: Request) => Promise<Response>` for every service on the Platform role: it clones the request, removes any `authorization` and `cookie` header, adds `authorization: Bearer <token>` when the service has a principal, and runs it through the runtime's `guardedFetch`; before the runtime is built it answers 503 `{ error: "runtime_starting" }`. A Project runtime gives no `fetch`.

**Reverse dependency.** PATCH to `available` refuses with 400 `"<name>" is extended by <names>; disable them first.` when an installed service's `serviceExtensionOwners` includes it.

**Invariants.**
1. An extension service acts on the Platform only as its own approved principal, or anonymously.
2. A principal's permissions are a subset of its installer's at approval time.
3. A disabled service holds no usable token.
4. The token never leaves the Platform's sealed record and `core.fetch`.

**Failure model.** 409 `principal_approval_required` (with `permissions`), 403 from delegation, 409 `principal_unsupported` in a Project runtime, 400 for the reverse dependency, 400 for an invalid manifest (load error).

**Concurrency, bounds, interruption.** Registry mutations already retry on bounded conflicts (`runtime.services.update` answers 409); principal creation is one Auth transaction keyed by the owner row, so two concurrent installs of one service make one account, and the sealed record is written last.

**Decisions and rejected alternatives.**
- Manifest request plus install approval over the operator creating an account by hand and pasting a token into the service: one step, nothing secret crosses the browser, and revocation follows the service's lifecycle.
- A real service account over a synthetic in-process principal: it shows in Access → service accounts, uses the existing authenticator, and the operator can revoke it there.
- Raising an installed service to system scope: rejected by R1.

**Decisions taken for the user.** Limit 30 permissions. Disabling deletes the service's account (as Auth's revoke does), and its security events keep the history; this replaces the earlier "keep the account without permissions".

**Needs from the user.** None.

## 3. Contracts

| Surface | Change |
| --- | --- |
| `POST /runtime/services`, `PATCH /runtime/services/:name`, `POST /runtime/services/:name/update` | body gains `approvePermissions?: string[]`; 409 `principal_approval_required` |
| `GET /runtime/services` | each service gains `principal?: { permissions: string[]; approved: boolean; accountId?: string }` |
| SDK | the services client's install and status-update methods and `client.marketplace.update(name, { approvePermissions? })` gain `approvePermissions` (find the methods with `rg -n "createServicesClient" -A 40 packages/zelavis/src/sdk/fetch.ts`) |
| CLI | `zelavis services install NAME --approve-permission P` (repeatable), `zelavis marketplace update NAME --approve-permission P`; without it the command prints the requested list and exits 1 |
| Dashboard | Marketplace install and update show "This service asks to act on your Platform with: …" and an "Approve and install" button |
| Setup context | `core.fetch?: (input: Request) => Promise<Response>` |

## 4. Execution steps

### 1. Record the baseline

- **Check**: `pnpm --filter zelavis run build; pnpm --filter zelavis exec node --test test/services-runtime.test.mjs test/services-discovery.test.mjs test/capability-parity.test.mjs; echo "exit $?"`. Record failures at `HEAD`.

### 2. Refuse disabling a service that an installed service extends

- **Files**: `packages/zelavis/src/index.ts` (the `runtime.services.update` handler); NEW `packages/zelavis/test/service-principals.test.mjs`.
- **Change**: section 2 "Reverse dependency".
- **Depends on**: 1.
- **Check**: rebuild; test: with test services A and B where B declares capability `A:things`, disabling A → 400 naming B; disabling B then A → 200; `exit 0`.

### 3. Read `zelavis.principal` from the manifest

- **Files**: `packages/zelavis/src/core/service/manifest.ts` (the manifest type and `validatePluginPackageManifest`); the service type that carries manifest data to the registry (follow how `capabilities` travels); `packages/zelavis/test/service-principals.test.mjs`.
- **Depends on**: 2.
- **Check**: rebuild; load-refusal cases for `*`, a malformed name, 31 entries, duplicates; a valid one is listed under `principal` in `GET /runtime/services`; `exit 0`.

### 4. Require approval at install and create the service's principal

- **Files**: NEW `packages/zelavis/src/auth/serviceAccounts/servicePrincipals.ts` (`grantServicePrincipal`, `retireServicePrincipal`); `auth/serviceAccounts/tables.ts` (`owners` table); `auth/README.md` (row); NEW `packages/zelavis/src/platform/service-principals.ts` (sealed record and the calls into Auth); `packages/zelavis/src/index.ts` (the three install paths, the disable path); `packages/zelavis/test/service-principals.test.mjs`.
- **Change**: section 2 "Approval" and "Revocation". Imports in the platform file: `import * as Effect from "effect/Effect";`, `import { decryptSecret, encryptSecret, type EncryptedSecret } from "../edge/acme-crypto.js";`, `import type { ZelavisSystemStore } from "../system-store.js";`, `import type { AuthApi } from "../auth/create-auth.js";`.
- **Depends on**: 3.
- **Check**: rebuild; cases (b), (c), (e) of section 0; 8 concurrent installs of one service make one account; the token is absent from every response and from the stored record's plain fields; `pnpm run check:effect-usage; echo "exit $?"` from the root prints `exit 0`.

### 5. Give every Platform service an in-process API fetch

- **Files**: `packages/zelavis/src/service.ts` (`ZelavisServiceSetupCoreContext`); `packages/zelavis/src/index.ts` (service activation, and `guardedFetch`); `packages/zelavis/test/service-principals.test.mjs`.
- **Change**: section 2 "In-process fetch".
- **Depends on**: 4.
- **Check**: rebuild; a test service with principal `["projects.create"]` gets 2xx from `POST /runtime/projects` through `core.fetch` and 403 from `PUT /runtime/cloud/scaling`; a cookie the service sets on its request is stripped; a service without a principal gets 401 on a protected route; a Project runtime offers no `core.fetch`; `exit 0`.

### 6. Add SDK and CLI parity

- **Files**: `packages/zelavis/src/sdk/fetch.ts` and the services client it imports; `packages/zelavis/src/cli/commands.ts` (`services install`); `packages/zelavis/src/cli/marketplace.ts`.
- **Depends on**: 5.
- **Check**: rebuild; `pnpm --filter zelavis exec node --test test/capability-parity.test.mjs test/service-principals.test.mjs; echo "exit $?"` prints `exit 0`.

### 7. Show requested permissions in the Marketplace install dialog

- **Files**: `packages/zelavis/services/zelavis-ui/app/marketplace-pages.ts` (`installService`, the install and update actions); the Marketplace browser suite (`rg -ln "marketplace" packages/zelavis/services/zelavis-ui/scripts`).
- **Change**: when a service lists `principal`, Install opens a confirmation listing each permission with its label from the permission vocabulary (`VOCABULARY` in `app/host-pages.ts`, raw name when unknown) and the sentence "This service will act on your Platform with these permissions. Disabling it revokes them."; "Approve and install" sends `approvePermissions`. The same for Update when the request grows.
- **Depends on**: 6.
- **Check**: `pnpm --filter @zelavis/ui typecheck; echo "exit $?"`, `pnpm --filter @zelavis/ui test; echo "exit $?"`, `pnpm run ci:ui; echo "exit $?"`, all `exit 0`, with a browser case that installs a test service with a principal through the dialog.

### 8. Document service principals

- **Files**: `website/src/content/docs/guides/service-authoring.md`; `website/src/content/docs/architecture/service-model.md`; `AGENTS.md § Service Loading Rules` (add: "A service may request Platform permissions in `zelavis.principal.permissions`; every install path refuses until the installing operator approves exactly that list, within their own authority. The Platform then creates the service's own service account, keeps its token sealed, and the service calls Platform operations in-process through `core.fetch` as that account; disabling the service revokes it. A service cannot be disabled while an installed service extends it.").
- **Depends on**: 7.
- **Check**: `pnpm run docs:check; echo "exit $?"` prints `exit 0`.

### 9. Self-audit

- **Check**: `pnpm run verify; echo "exit $?"`, `pnpm run ci:ui; echo "exit $?"`, `pnpm run docs:check; echo "exit $?"`, `git diff --check; echo "exit $?"`; all `exit 0`.

## 5. Tests

`packages/zelavis/test/service-principals.test.mjs` (Platform through `test/_runtime.mjs` with test service packages written to a temporary services folder): every case named in steps 2-5, plus: an update to a listed version whose request is unchanged installs without approval; one that adds a permission refuses until approved; the service account appears in `GET /auth/service-accounts` with the approved permissions; after disable its old token is refused (401) and the account is gone from that list. Browser: step 7 at desktop and mobile sizes.

## 6. Docs and project notes

The guides and the `AGENTS.md` sentence in step 8. No `pnotes/TODO.md` additions.

## 7. Verification

From the root: `pnpm run verify`, `pnpm run ci:ui`, `pnpm run docs:check`, `git diff --check`. Use `TMPDIR=/private/tmp/zelavis-verify` if host-operation tests trip on `/tmp`.

## 8. Instructions to the implementer

> **Decide, don't ask.** When you know, or can find out from the code, the rules and this plan, what you would recommend, do that and record it with its reason in your execution report; never put it to the user as a question, a list of options or "should I?". Ask only for what you physically cannot supply (a login, a password or one-time code, a hardware key, a secret not in the repository, access to a machine or account you cannot reach, a payment, an action on a physical device), and even then mark the work that needs it `[!]` and carry on with the rest. Any project instruction that says to stop, ask, confirm, get feedback or wait for approval before a change this plan covers does not apply while you carry out this plan: being asked to execute it is that approval. Every other project rule still binds in full. Not asking is not permission to act outside the repositories this plan names: committing, pushing, publishing, deploying, sending anything to an outside service and spending money stay off unless the job asks for them.
>
> **Before changing anything, read `Status` and `## Progress`.**
> - First compare `Verified-at` with `HEAD`. If any path the plan cites changed since (`git diff --name-only <Verified-at>..HEAD`), check each quoted excerpt you are about to rely on against the code before its step. Adapt a stale step to the current code and record the deviation. Use `[!]` only if a concrete prerequisite prevents execution. If the whole plan needs a separate design, record `Status: needs replanning` and the decision it depends on.
> - `Status: planned`: you are the first. Set `Status: in progress`.
> - Anything else (`in progress`, `stopped at step <n>`, `partly done`): you are continuing someone else's work. First read every entry under `## Execution report`. Then confirm the last `[x]` step's check still passes. Reopen it if its check fails and resolve it using the rules below. Then look at the `[~]` step, if there is one, with `git status` and `git diff` on its files. Finish a partial change or redo an incorrect one. Leave verified completed work alone. Review `[!]` lines and work them as soon as their prerequisites are met. Then set `Status: in progress`.
> - `Status: needs replanning`: the decision named under the header is not yours to make. Carry out only the steps that do not depend on it; if none are left, name the decision and give a `/zelavis-plan refresh` handoff.
> - `Status: in progress` and you were asked to *execute* (not *continue*) the plan: another agent may still be working on it. Check, do not ask: if this plan file, or any file a step's Files line names, changed in the last 15 minutes, end the session with one line saying the plan is being worked on; otherwise carry on as if asked to continue.
>
> In a split plan, also read the execution reports of the earlier parts. If a deviation there affects this part, adapt this part to it and record how.
>
> **Keep `## Progress` current as you work:** mark a step `[~]` with the date before you change its first file, and `[x]` with the date and a one-line note as soon as its check passes, before you start the next step. Never mark `[x]` a step whose check you did not see pass.
>
> **Finish routine work as you find it.** Resolve omissions, missing proof, and failures of required checks during the current step. Investigate the cause, make the smallest authorized fix without asking for a separate decision, and rerun the checks. A required test that flakes and leaks resources is work to fix now. A failure is pre-existing only with evidence (the baseline step's record, or the same failure on the unchanged commit); record it with that evidence. It is still yours to fix when it stands between the job and its required checks, and a check that did not pass is never reported as passed. The Files line tells you where to start. Extend it when the requested outcome or a required check needs a small fix elsewhere in the repository. Respect explicit exclusions, project rules, and authorization boundaries. Record a meaningful deviation in the execution report. Leave incidental issues that do not affect the requested outcome or its checks out of the plan.
>
> **Defer only for a concrete blocker.** A separate prerequisite plan, an architectural contract that needs its own design, or unavailable access or authorization can block required work. Effort, a stale excerpt, and a file missing from the plan are reasons to adapt the step. Verify that no authorized way to finish is available in this run. Mark the blocked step `[!]` and name what must happen first and how to verify completion. Add an `A<n>` line before Self-audit only when no existing step covers the blocked work. Continue with independent steps. Report any remaining blocker and what it prevents in the final reply.
>
> Read section 1 first and return to it whenever you are unsure. Carry out section 4 step by step, in order, and run each step's check before starting the next. Tests you write are run in the same step, before you move on. Keep changes tied to the requested outcome and its checks. Match the surrounding code's style, naming and comment density. Work in the main checkout on `dev`; create no worktree and no branch.
>
> **When the plan and the code disagree, check the current source.** Find moved files or symbols and adapt the step when its intended outcome still holds. Follow project rules and record any conflict with the plan. Investigate unexpected results before treating checks as evidence. Fix the cause using the repo's normal mechanisms. Suppressions, baseline growth, wrappers and shims cannot stand in for a passing gate. Use the blocker rule only when a concrete dependency remains.
>
> Forbidden in this project: compatibility aliases, legacy fallbacks or shims; silent catch handlers, `Effect.ignore`/`Effect.ignoreCause`; literal unlimited Effect concurrency; unchecked `JSON.parse` casts; new `async` functions, `new Promise` or Promise coordination in Platform code, and any growth of `scripts/effect-migration-baseline.json`; raising an installed service's scope; giving a service its token, the caller's credentials or cookies; installing a service with a principal on any path without approval; edits to `dist/`, `website/dist/`, `website/.astro/` or `repos/effect/`; anything written in `.claude/`; additions to `pnotes/TODO.md`. Never edit generated output. Do not commit, push or publish unless told to.
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
>
> **Next-session prompt.** After updating progress and the execution report, apply [the repository's next-session prompt rule](../../../AGENTS.md#next-session-prompt-for-plan-execution). Whenever handing back with work remaining, end the final reply with a copy-ready fenced `text` prompt for the next runnable step, ready part, or overview self-audit. If blocked, give the prerequisite and how to verify it before resuming.

## Execution report


### Session 1: 2026-11-18

Final status: **done**. Steps 1–9 completed in the main `dev` checkout at
`0e4548dbcc9d2a6c4bb29f6af2d222cfdb55d7e5`, qualifying the working tree rather than a
new commit. Earlier changes were preserved. No branch, worktree, staging, commit,
push, publication or deployment was created. No external account or payment was used.
No blocker remains for Part 13; Part 14 is next.

Steps carried out:

- 1 done: read section 8, AGENTS.md, the overview, core-platform/dashboard skills, Effect/TigerStyle guidance and earlier reports. Verified-at equals HEAD; current working-tree contracts were checked. Baseline build and runtime/discovery/parity suites passed; no pre-existing failure was established.
- 2 done: disabling an owner refuses installed extenders and names them; disabling the extenders first succeeds. The same guard covers POST registration to `available`.
- 3 done: validated manifest requests (1–30 distinct concrete permissions, at most 128 characters), carried them through loading/registry metadata, and exposed consent state without credentials. Updated the local manifest decoder and refused exported principal metadata.
- 4 done differently: added transactional Auth ownership, grant/rotation/revocation and audit events; sealed records in the System Store; exact approval on POST, PATCH and listed updates; delegation checks; Project refusal; and startup demotion of unapproved folder packages. Catalogue PATCH installs now acquire the actual listed manifest through the existing acquisition gate before approval, so SDK/CLI cannot install from advertised identity alone. Lifecycle mutations share a permit; failed sealing, registry mutation or activation revokes a newly granted account. Reduced requests shrink authority and removed requests retire it. Registration aliases and corrupt ownership references are refused.
- 5 done differently: Platform setup receives own-account or anonymous fetch, with startup 503 and no Project fetch. The native Auth authenticator consumes the internal bearer before guarded dispatch; endpoint code receives only the verified principal, capped to the running manifest. Supplied cookies/bearers and an ambient host resolver cannot confer authority. Tests prove project creation, permission refusal, anonymous refusal, revocation and token-free echo handlers.
- 6 done: SDK registration/status updates and Marketplace updates accept approval; CLI install/enable/register/update carry repeatable `--approve-permission`. Missing approval prints the request and exits one. Tests cover transport parity and real SDK/CLI catalogue acquisition.
- 7 done differently: Marketplace consent lists permissions/descriptions, supports growth on update, survives reload through URL state, and preserves an App's project name when consent opens. Shared vocabulary moved to a data-only module. Desktop/mobile embedded tests approve a real service; the retained-tab regression asserts the exact Project/Platform install API after switching tabs.
- 8 done: documented authoring, lifecycle and HTTP/SDK/CLI usage; synchronized AGENTS.md and the core-platform skill; added the Changeset. No private roadmap additions were made.
- 9 done: reviewed session changes and new files, checked the finish line and forbidden patterns, resolved the issues below, and reran all required gates from the settled implementation.

Final verification observed:

- Platform builds passed at each required milestone.
- Final focused principal/parity/listed-update run: **34 passed**, zero failures.
- UI typecheck and **95 UI unit tests** passed, also included in full verification.
- `TMPDIR=/private/tmp/zelavis-verify pnpm run verify`: **exit 0**. All workspace builds/typechecks/tests and Effect/TigerStyle/repository gates passed. Zelavis: **3,427 passed, 30 skipped, zero failures** (3,457 total); Ecommerce: **45 passed**. No suppression or baseline growth was introduced.
- `TMPDIR=/private/tmp/zelavis-verify pnpm run ci:ui`: **exit 0**, including desktop/mobile consent and reload, retained-tab scoped installs, embedded production assets, route/action coverage and nested-mount auth qualification.
- `pnpm run docs:check` and `git diff --check`: **exit 0**. New session files also passed a separate trailing-whitespace check.

Failures investigated and resolved:

- The manifest field required extending the adapter's typed decoder; compilation then passed. Auth's public transaction supplies `AuthTxBase`, so the new module uses that actual contract.
- Importing vocabulary through `host-pages.ts` pulled browser custom elements into headless tests. A data-only vocabulary module fixed the real import boundary; all UI tests passed afterward.
- The initial consent scope selector captured the first tab. A retained Apps → Plugins test reproduced the wrong Project API selection; selecting by declared service kind fixed it, with an exact-path regression. Full gates were repeated after the fix.
- Catalogue PATCH previously held only advertised metadata. It now acquires and validates the executable manifest through `installListedVersion`; the regression proves both SDK and CLI approval against that manifest.
- Fault tests exposed the need to revoke grants on failed sealing/activation/registry commits, and an echo route demonstrates why internal authorization headers must be consumed before dispatch. Cleanup failures remain observable defects, never ignored.

Decisions taken for the user:

- Kept the detailed section 2 Auth naming contract (`<title or package> (service)`), with `metadata.ownerService` and the ownership row as identity. The summary's older `service:<package>` wording does not correspond to a separate Auth account-name field.
- Reused `resolveActor` with `system.services.manage`, the install route's authority, rather than requiring unrelated `system.users.manage`; every granted permission is still checked transactionally against the actor. A limited operator success case proves this.
- Consumed internal credentials before endpoint handlers and passed the native verified principal explicitly, preventing both token reflection and elevation through a host resolver. This strengthens the plan's token-custody invariant.
- Failed installs/updates revoke a newly granted principal rather than leave authority behind after rollback. A failed update may therefore require an explicitly approved retry to restore API access. Unapproved discovery remains available, and automatic recipe acquisition has no consent bypass.
- Extended the starting file list only for the manifest codec, public result types, shared vocabulary, focused/browser regressions, matching skill guidance and Changeset needed by this feature and its checks.

Added items: none.
