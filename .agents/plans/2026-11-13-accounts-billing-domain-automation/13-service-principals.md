# Service principals approved at install
Job: Let an installed service ask for Platform permissions in its manifest, have the operator approve exactly those permissions when installing it, and act with them through an in-process API client; and refuse disabling a service another installed service extends. Hosting (part 14) is the first user; any service can use it.
Date: 2026-11-13
Status: planned
Verified-at: b04fa02d95
Part: 13 of 14. Read 00-overview.md first.

To start:    Execute part 13 in .agents/plans/2026-11-13-accounts-billing-domain-automation/13-service-principals.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-13-accounts-billing-domain-automation/13-service-principals.md. Start with its section 8.

## Progress

- [ ] 1. Record the baseline.
- [ ] 2. Refuse disabling a service that an installed service extends.
- [ ] 3. Read `zelavis.principal` from the manifest.
- [ ] 4. Require approval at install and create the service's principal.
- [ ] 5. Give every Platform service an in-process API fetch.
- [ ] 6. Add SDK and CLI parity.
- [ ] 7. Show requested permissions in the Marketplace install dialog.
- [ ] 8. Document service principals.
- [ ] 9. Self-audit.

## 0. Summary and finish line

A service installed from the Marketplace runs at extension scope (`AGENTS.md § Platform And App Service Boundary`), which is right, but it then has no way to act on the Platform: no in-process API client and no authority of its own. A hosting business needs a service that creates Projects and assigns access to customers. Instead of a special case for Hosting, this part adds one general mechanism, the way a phone asks before an app gets permissions: the manifest names the permissions a service needs (`zelavis.principal.permissions`), the install refuses until the installing operator approves exactly that list (and only permissions the operator holds, as delegation already requires), the Platform then creates a service account for the service and keeps its token sealed, and the service calls Platform operations in-process through `core.fetch` as that account. Disabling the service revokes the account. The part also adds the missing reverse check: a service cannot be disabled while an installed service extends it (Ecommerce while Hosting or a payment plugin is installed).

- **In scope**: manifest field and validation; approval on every install path (acquire, PATCH, update to a listed version); service account creation, sealing and revocation; `core.fetch` for every Platform service; the reverse-dependency refusal; SDK, CLI and Marketplace dialog; docs.
- **Out of scope**: principals for services in Project runtimes (a service declaring one is refused there with `principal_unsupported`; a Project has no Platform authority to give); per-request consent; changing a principal's permissions without reinstalling or updating.
- **Done means**: (a) a manifest with `zelavis.principal.permissions` loads; one with `*`, a malformed permission or more than 30 is refused at load; (b) installing such a service without `approvePermissions` answers 409 `principal_approval_required` listing the permissions, and with a different list 409 again; with the exact list it installs, and a service account named `service:<package name>` exists with those permissions; (c) an operator lacking one of the permissions cannot approve it (403, delegation); (d) the service's `core.fetch` reaches Platform routes as that account and is refused where the account has no permission; a service without a principal gets anonymous `core.fetch`; (e) disabling the service revokes the account's tokens, and reinstalling asks again; an update whose manifest asks for more permissions refuses until approved; (f) disabling a service another installed service extends answers 400 naming the extenders; (g) parity, browser, `verify`, `ci:ui`, `docs:check` pass.
- **Owner decision (2026-11-13, this conversation)**: Hosting is its own service with plans and billing that requires Ecommerce, not part of core and not bundled; this part is the general mechanism that lets such a service act on the Platform through ordinary grants.
- **Supplement**: updated in this run (overview section 0).
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
- Install paths: `POST /runtime/services` (`runtime.services.create`, `packages/zelavis/src/index.ts:3006-3066`, body read by `readDashboardServiceRegistryCreate` `:1205`); `PATCH /runtime/services/:name` (`runtime.services.update` `:3316-3330`; install-time extension check `:3372-3396`); `POST /runtime/services/:name/update` (`runtime.services.updateToListed` `:3067-3080`). All `system.services.manage`.
- Dashboard install `packages/zelavis/services/zelavis-ui/app/marketplace-pages.ts:47-49` (`installService`: POST with `packageSource` when `installVia === "acquire"`, else PATCH `{ status: "installed" }`); update `:69`.
- CLI `zelavis services install|enable|disable|uninstall NAME` `packages/zelavis/src/cli/commands.ts:514-530` (`updateRuntimeService(name, { status })`); `zelavis marketplace update NAME` (`packages/zelavis/src/cli/marketplace.ts`). SDK `createServicesClient` (`packages/zelavis/src/sdk/fetch.ts:2230`) and `client.marketplace.update` (`:2166`).
- Manifest validation `packages/zelavis/src/core/service/manifest.ts:55` (`validatePluginPackageManifest`; capabilities `:142-152`, namespace `:178-181`).
- Service accounts: create `packages/zelavis/src/app/identity/identity-service.ts:1132-1190` (name, `permissions`, `grants`, `assertCanDelegateAccountAccess(actor, …)`), token `:1226-1258` (`sessions.revokeAll` then `sessions.create` with `metadata: { authentication: "service-token", serviceAccount: true }`), revoke `:1259`.
- Setup context `packages/zelavis/src/service.ts:217-255`; runtime fetch `packages/zelavis/src/index.ts:7895-7902`.
- Sealing: `loadPlatformMasterSecret` `packages/zelavis/src/platform/master-secret.ts:19`; `encryptSecret`/`decryptSecret` `packages/zelavis/src/edge/acme-crypto.ts:79`, `:104`.

**Pattern to mirror.** The install-time extension check (`index.ts:3372-3396`) for where approval is checked; the service-account handlers for how an account and token are made (call the same `IdentityApi` methods in-process, never the HTTP route); the cloud token's sealing (`packages/zelavis/src/platform/cloud-capacity.ts:57`, `:180-187`).

**Traps.**
- Handing the token to the service: the service never sees it. The Platform keeps it sealed and adds the `authorization` header inside `core.fetch`.
- Approving on the service's behalf in code paths that "install defaults": bundled services are system scope and need none; any extension install path without the approval list must refuse.
- Approving more than the operator holds: run the same delegation check the service-account route runs, with the installing principal as actor.
- Leaving the account alive after disable: revoke its sessions in the same operation that disables the service; a failed revoke fails the disable.
- Comparing approval as an ordered list: compare as sets.

## 2. Design

**Manifest.** `zelavis.principal?: { permissions: string[] }`: 1-30 strings, each matching the account-access permission pattern `^[a-z][a-z0-9.\-:/]*$` (1-128 characters, `packages/zelavis/src/app/identity/domain/account-access.ts:9-12`), never `*`, no duplicates. Absent means the service has no principal.

**Approval.** Every install of a service with a principal (POST create with `status: "installed"`, PATCH to `installed`, `updateToListed` when the newer manifest's set is not a subset of the approved one) needs body field `approvePermissions: string[]` equal as a set to the request; otherwise 409 `{ error: "principal_approval_required", permissions: [...] }`. The handler then, before activation: (1) `assertCanDelegateAccountAccess(installer, platform context, { permissions, grants: [] })` (403 on failure); (2) find or create the account with username `service:<package name>`, display name `<marketplace title or package name> (service)`, `metadata.principalType: "service"`, `metadata.ownerService: <package name>`, the approved permissions; (3) issue a token (no expiry beyond the existing maximum of 3650 days) the way the rotate route does; (4) store `{ schemaVersion: 1, accountId, permissions, sealed: EncryptedSecret, approvedBy, approvedAt }` at System Store `zelavis.service-principals` / `<package name>`, key purpose `service-principal:<package name>`. A failure in (2)-(4) fails the install and leaves no record; an account created in (2) without a stored record is found again by username on retry.

**Revocation.** PATCH to `available` (CLI `disable`/`uninstall`) revokes the account's sessions (`sessions.revokeAll`) and deletes the stored record, before deactivation. The account stays (audit history), with no permissions (`permissions: []`), so reinstalling restores permissions through approval.

**In-process fetch.** `ZelavisServiceSetupCoreContext.fetch?: (input: Request) => Promise<Response>` for every service on the Platform role: it clones the request, removes any `authorization` and `cookie` header, adds `authorization: Bearer <token>` when the service has a principal, and runs it through the runtime's `guardedFetch`; before the runtime is built it answers 503 `{ error: "runtime_starting" }`. A Project runtime gives no `fetch`.

**Reverse dependency.** PATCH to `available` refuses with 400 `"<name>" is extended by <names>; disable them first.` when an installed service's `serviceExtensionOwners` includes it.

**Invariants.**
1. An extension service acts on the Platform only as its own approved principal, or anonymously.
2. A principal's permissions are a subset of its installer's at approval time.
3. A disabled service holds no usable token.
4. The token never leaves the Platform's sealed record and `core.fetch`.

**Failure model.** 409 `principal_approval_required` (with `permissions`), 403 from delegation, 409 `principal_unsupported` in a Project runtime, 400 for the reverse dependency, 400 for an invalid manifest (load error).

**Concurrency, bounds, interruption.** Registry mutations already retry on bounded conflicts (`index.ts:3316-3330` 409); principal creation is idempotent by username, and the stored record is written last.

**Decisions and rejected alternatives.**
- Manifest request plus install approval over the operator creating an account by hand and pasting a token into the service: one step, nothing secret crosses the browser, and revocation follows the service's lifecycle.
- A real service account over a synthetic in-process principal: it shows in Access → service accounts, uses the existing authenticator, and the operator can revoke it there.
- Raising an installed service to system scope: rejected by R1.

**Decisions taken for the user.** Limit 30 permissions; the account is kept with no permissions after disable, for history.

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

- **Files**: `packages/zelavis/src/index.ts` (PATCH handler near `:3372`); NEW `packages/zelavis/test/service-principals.test.mjs`.
- **Change**: section 2 "Reverse dependency".
- **Depends on**: 1.
- **Check**: rebuild; test: with test services A and B where B declares capability `A:things`, disabling A → 400 naming B; disabling B then A → 200; `exit 0`.

### 3. Read `zelavis.principal` from the manifest

- **Files**: `packages/zelavis/src/core/service/manifest.ts` (type `:10-11` area and `validatePluginPackageManifest` `:55`); the service type that carries manifest data to the registry (follow how `capabilities` travels); `packages/zelavis/test/service-principals.test.mjs`.
- **Depends on**: 2.
- **Check**: rebuild; load-refusal cases for `*`, a malformed name, 31 entries, duplicates; a valid one is listed under `principal` in `GET /runtime/services`; `exit 0`.

### 4. Require approval at install and create the service's principal

- **Files**: NEW `packages/zelavis/src/platform/service-principals.ts`; `packages/zelavis/src/index.ts` (the three install paths, the disable path); `packages/zelavis/test/service-principals.test.mjs`.
- **Change**: section 2 "Approval" and "Revocation". Imports in the new file: `import { Effect } from "effect";`, `import { decryptSecret, encryptSecret, type EncryptedSecret } from "../edge/acme-crypto.js";`, `import type { ZelavisSystemStore } from "../system-store.js";`, `import type { IdentityApi } from "../app/identity/index.js";`, `import { integration } from "../core/runtime/effect-boundary.js";`.
- **Depends on**: 3.
- **Check**: rebuild; cases (b), (c), (e) of section 0; the token is absent from every response and from the stored record's plain fields; `pnpm run check:effect-usage; echo "exit $?"` from the root prints `exit 0`.

### 5. Give every Platform service an in-process API fetch

- **Files**: `packages/zelavis/src/service.ts:217-235`; `packages/zelavis/src/index.ts` (activation near `:7043`, runtime fetch near `:7895`); `packages/zelavis/test/service-principals.test.mjs`.
- **Change**: section 2 "In-process fetch".
- **Depends on**: 4.
- **Check**: rebuild; a test service with principal `["projects.create"]` gets 2xx from `POST /runtime/projects` through `core.fetch` and 403 from `PUT /runtime/cloud/scaling`; a cookie the service sets on its request is stripped; a service without a principal gets 401 on a protected route; a Project runtime offers no `core.fetch`; `exit 0`.

### 6. Add SDK and CLI parity

- **Files**: `packages/zelavis/src/sdk/fetch.ts`; `packages/zelavis/src/cli/commands.ts:514-530`; `packages/zelavis/src/cli/marketplace.ts`.
- **Depends on**: 5.
- **Check**: rebuild; `pnpm --filter zelavis exec node --test test/capability-parity.test.mjs test/service-principals.test.mjs; echo "exit $?"` prints `exit 0`.

### 7. Show requested permissions in the Marketplace install dialog

- **Files**: `packages/zelavis/services/zelavis-ui/app/marketplace-pages.ts:47-69`; the Marketplace browser suite (`rg -ln "marketplace" packages/zelavis/services/zelavis-ui/scripts`).
- **Change**: when a service lists `principal`, Install opens a confirmation listing each permission with its label from the permission vocabulary (`host-pages.ts:240`, raw name when unknown) and the sentence "This service will act on your Platform with these permissions. Disabling it revokes them."; "Approve and install" sends `approvePermissions`. The same for Update when the request grows.
- **Depends on**: 6.
- **Check**: `pnpm --filter @zelavis/ui typecheck; echo "exit $?"`, `pnpm --filter @zelavis/ui test; echo "exit $?"`, `pnpm run ci:ui; echo "exit $?"`, all `exit 0`, with a browser case that installs a test service with a principal through the dialog.

### 8. Document service principals

- **Files**: `website/src/content/docs/guides/service-authoring.md`; `website/src/content/docs/architecture/service-model.md`; `AGENTS.md § Service Loading Rules` (add: "A service may request Platform permissions in `zelavis.principal.permissions`; every install path refuses until the installing operator approves exactly that list, within their own authority. The Platform then creates the service's own service account, keeps its token sealed, and the service calls Platform operations in-process through `core.fetch` as that account; disabling the service revokes it. A service cannot be disabled while an installed service extends it.").
- **Depends on**: 7.
- **Check**: `pnpm run docs:check; echo "exit $?"` prints `exit 0`.

### 9. Self-audit

- **Check**: `pnpm run verify; echo "exit $?"`, `pnpm run ci:ui; echo "exit $?"`, `pnpm run docs:check; echo "exit $?"`, `git diff --check; echo "exit $?"`; all `exit 0`.

## 5. Tests

`packages/zelavis/test/service-principals.test.mjs` (Platform through `test/_runtime.mjs` with test service packages written to a temporary services folder): every case named in steps 2-5, plus: an update to a listed version whose request is unchanged installs without approval; one that adds a permission refuses until approved; the service account appears in `GET /auth/service-accounts` with the approved permissions; after disable its old token is refused (401). Browser: step 7 at desktop and mobile sizes.

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
> - `Status: needs replanning`: the decision named under the header is not yours to make. Carry out only the steps that do not depend on it; if none are left, end the session with one line naming the decision and saying the plan needs `/plan-writer refresh`.
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

## Execution report
