# Custom role definitions

Job: Let operators define named roles (bundles of permissions and grants, optionally parameterized by Project) and assign them to human accounts within their own authority, on the Platform and in native Apps.
Date: 2026-11-13
Status: done
Verified-at: 0e4548dbcc (refreshed 2026-11-16 against the Zelavis Auth working tree, before it was committed)
Part: 6 of 14. Read 00-overview.md first.

To start:    Execute part 6 in .agents/plans/2026-11-13-accounts-billing-domain-automation/06-custom-roles.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-13-accounts-billing-domain-automation/06-custom-roles.md. Start with its section 8.

## Progress

- [x] 1. Prove the access baseline at HEAD. (2026-11-16: build, auth-admin, auth-invitations, platform-gateway-authority pass)
- [x] 2. Add the role catalogue schema and repository. (2026-11-16: `auth/roles/{tables,catalogue,roles}.ts`; 16 concurrent creates commit once)
- [x] 3. Expand role assignments into principals. (2026-11-16: `auth/roles/{expand,cache}.ts`; edits propagate without touching the account)
- [x] 4. Add role assignments to account access and invitations. (2026-11-16: required `roleAssignments`; admin, invitations, gateway, parity suites pass)
- [x] 5. Add the role service and routes. (2026-11-16: `auth/routes/roles.ts`; `auth-roles.test.mjs` 8/8)
- [x] 6. Add the exact Project Gateway routes. (2026-11-16: four App role routes plus role-aware access and invitation proofs; Gateway cases pass)
- [x] 7. Add SDK and CLI parity. (2026-11-16: `client.auth.admin.*Role*`, `client.projects.*Role*`, `zelavis auth|projects roles…`; capability-parity passes)
- [x] 8. Add the dashboard Roles pages and the editor's role picker. (2026-11-16: `app/roles-page.ts`, editor picker; UI typecheck/test and ci:ui pass)
- [x] 9. Document custom roles. (2026-11-16: access-control, packages/auth, api/platform-operations, package README, AGENTS module list; docs:check passes)
- [x] 10. Self-audit. (2026-11-16: verify, ci:ui, docs:check, git diff --check exit 0 after the last edit)

## 0. Summary and finish line

Roles today are fixed labels (`customer`, `operator`, `reseller` on the Platform, `user` in an App; `RoleSchema` in `packages/zelavis/src/auth/access/access.ts`) that carry no permissions; every permission and grant is set per account. Giving ten customers the same "Project developer" access to their own Projects means ten hand-built grant lists that drift. This part adds a per-runtime role catalogue: a role is a named bundle of runtime-wide permissions, concrete grants and Project permission templates; an account gets role assignments (each optionally naming Projects); authority is expanded at authentication, so editing a role changes every member's authority on their next request.

- **In scope**: catalogue (≤ 50 roles), assignments (≤ 10 per account, ≤ 20 Projects each), expansion in the session principal, delegation checks on definition and assignment, access-edit and invitation inputs, Platform and App runtimes, Gateway, SDK, CLI, dashboard, docs, tests.
- **Out of scope**: role inheritance, deny rules, conditions or time limits, service-account role assignment (service accounts keep explicit permissions), changing the fixed role label set.
- **Done means**: (a) an operator holding `system.roles.manage` defines `project-developer` with Project permissions `project.view`, `project.domains.manage`; (b) assigning it to a customer for Projects P and Q makes `GET /runtime/projects` show exactly P and Q and lets the customer manage their domains; (c) removing `project.domains.manage` from the role makes the customer's next domain request 403 without touching the account; (d) an actor cannot define or assign a role containing authority they do not hold; (e) deleting a role removes the authority it gave; (f) App roles work for App users through the Gateway; (g) parity, browser, `verify`, `ci:ui`, `docs:check` pass.
- **Supplement**: updated in this run (overview section 0).
- **Refreshed 2026-11-16** (Zelavis Auth plan part 16): rebuilt on Zelavis Auth. Roles are rows of a NEW `roles` Auth module in the runtime's Auth partition, checked and written inside `documents.transaction` like every Auth change; the HTTP contract in section 3 is unchanged.
- **Sources read**: `AGENTS.md § Core Access-Control Rule`, `§ Database Architecture Rules` (scalability rule one); files below.

## 1. Context packet

**Glossary.**
- **Role catalogue**: one record per runtime holding all role definitions and a revision.
- **Role assignment**: `{ roleId, projectIds? }` on an account.
- **Expansion**: turning an account's direct access plus its assignments into the principal's `permissions` and `grants`.
- **Built-in role label**: the existing single `role` (`customer` etc.); unchanged, still decides `canDelegateRole` (`packages/zelavis/src/auth/access/delegation.ts` → `canDelegateRole`).

**Governing rules.**
> "Zelavis uses one core principal, permission, and scoped-grant model across the owner console, project dashboards, future customer/reseller/operator views, service accounts, CLI calls, scripts, plugins, and AI agents." `AGENTS.md § Core Access-Control Rule`
>
> "Project and service grants require the same explicit route identity and never satisfy an unscoped requirement" `AGENTS.md § Core Access-Control Rule`
>
> "A change that adds a per-Tenant read, record or loop to a hot path or to the authority needs a different design." `AGENTS.md § Database Architecture Rules` (the same spirit: expansion costs one cached catalogue read, not a read per role or per account).

**System today** (Zelavis Auth, `AGENTS.md § Zelavis Auth`).
- Principal construction `accountSessionPrincipal(account, sessionId, transport, projectId?)` in `packages/zelavis/src/auth/accounts/principal.ts`: Platform principals get `permissions` and `grants`; App principals get the account's permissions as grants scoped to the App's Project. Called by the request authenticator (`auth/core/authenticator.ts` → `authenticate`, which reads the session row and then the account on every request), by `resolveActor` (`auth/access/delegation.ts`) and by invitation acceptance (`auth/invitations/accept.ts`).
- Access schemas in `auth/access/access.ts`: `delegatedAccessFields`, `DelegatedAccessSchema`, `SetAccountAccessInputSchema` (`expectedRevision` + access, `ACCOUNT_ACCESS_LIMIT = 100`), `AccountAccessResultSchema`, `normalizeAccountAccess`, `projectAccountAccessPermissions`, `projectAccountAccessDigest` (the Gateway's proof), `accountGrantKey`.
- Delegation and the write, both inside the administrator's transaction: `canDelegateAccess`, `resolveActor` and `setAccountAccess` in `auth/access/delegation.ts` (`setAccountAccess` checks `expectedRevision`, raises `accessRevision`, ends the account's sessions and records `account.access.changed`).
- Access route `auth.accounts.access.set` (`PUT /accounts/:accountId/access`) and the error table in `auth/routes/admin.ts`.
- Account row `accountsTables.accounts` in `auth/accounts/tables.ts` (`roles`, `permissions`, `grants`, `accessRevision`).
- Module tables: `defineTables("<module>", { … })` in `auth/runtime` (example: `auth/registration/tables.ts`, one policy row with a revision); a module joins `createAuth` in `auth/create-auth.ts`.
- Gateway account access route `runtime.projects.auth.accounts.access.set` in `packages/zelavis/src/platform/project-gateway.ts`.
- Invitations carry `access` (`DelegatedAccess`) and apply it at acceptance (`auth/invitations/{invitations,accept}.ts`).
- Dashboard: access editor `packages/zelavis/services/zelavis-ui/app/account-access-editor.ts`, Server Access pages in `app/host-pages.ts` (`VOCABULARY`, `permissionsScreen`, `accessUsersScreen`), routes in `app/dashboard-routes.ts`.

**Pattern to mirror.** The registration module (`auth/registration/{tables,policy}.ts`: a revision row read and written in the deciding transaction) for the catalogue revision; `canDelegateAccess` for every check; `setAccountAccess` for the conditional access write.

**Traps.**
- Copying role content into the account at assignment: edits would not propagate, and revocation would need a scan of all accounts.
- Reading role rows on every request: the authenticator expands from an in-process copy of the catalogue (at most 50 rows), reloaded only when the catalogue revision this runtime wrote has moved.
- Expanding a Project template for every Project when no `projectIds` are given: a role without `projectIds` gets no Project grants from its templates (never "all Projects").
- Letting a role edit escalate members beyond what the editor holds: the editor must hold every permission and grant in the new definition.
- Forgetting the Gateway digest: `normalizeAccountAccess` and `projectAccountAccessDigest` must include `roleAssignments`, or the child accepts an unsigned change.
- Checking delegation outside the transaction that writes: the actor and the roles it assigns are read in the same `documents.transaction` that writes the account or the role, as `setAccountAccess` already does.

## 2. Design

**Authority and scope.** The runtime owns its catalogue. Platform: define/edit/delete need NEW `system.roles.manage` (system scope); assignment is part of account access (`system.users.manage`). App: define and assign need `project.users.manage` on its Project (Apps have one operator tier); the Gateway exposes exact routes with `project.users.manage`.

**Persistence.** NEW Auth module `roles` (`packages/zelavis/src/auth/roles/tables.ts`), in the runtime's Auth partition:

```ts
// roles_catalogue: one row, the revision every role change raises (no row reads as revision 0)
{ revision: number }
// roles_roles: one row per role (≤ 50), index by_roleId
interface RoleDefinition {
  roleId: string;                           // ^[a-z][a-z0-9-]{1,47}$, not a built-in label or owner/service/system
  title: string;                            // 1-80, no control characters
  description?: string;                     // ≤ 500
  permissions: readonly string[];           // Platform: runtime-wide. App: become grants scoped to the App's Project, as account permissions do (accountSessionPrincipal)
  grants: readonly ConcreteAccountGrant[];  // concrete scopes; App: must be empty
  projectPermissions: readonly string[];    // Platform only: templates applied to each assigned Project; App: must be empty
  createdAt: number; updatedAt: number;
}
```

`accountsTables.accounts` gains optional `roleAssignments: readonly { roleId: string; projectIds?: readonly string[] }[]` (absent reads as none, so accounts already stored by an installed release need no rewrite; ≤ 10, ≤ 20 Project IDs each, canonical Project IDs per `ProjectIdSchema` in `access.ts`). Total entries of one role ≤ 100.

**Expansion.** `expandAccountAccess(account, roles): { permissions, grants }` (NEW, pure, `auth/roles/expand.ts`): start with the account's own; for each assignment whose role exists add `role.permissions`, `role.grants`, and for each `projectId` add `{ permission, scope: { type: "project", projectId } }` for every `role.projectPermissions`; deduplicate with `accountGrantKey`. Bounded: ≤ 10 × (100 + 20 × 100) entries; refuse definitions or assignments whose worst-case expansion exceeds 2000 grants (`role_expansion_limit`). `accountSessionPrincipal` takes the expanded access. The authenticator gets the roles from a `RoleCatalogueCache` (NEW, `auth/roles/cache.ts`): it holds the rows and the revision it loaded; the roles module clears it after each committed write in this runtime, which is the catalogue's only writer (one Auth writer per runtime). Inside a transaction (`resolveActor`, `setAccountAccess`, invitation acceptance, role writes) the roles are read through `tx.db`, never the cache, so a decision and its write see the same catalogue.

**Delegation.**
- Define or edit: the actor must be able to delegate the role's full content (`permissions`, `grants`, and `projectPermissions` for every Project in which it holds them). For `projectPermissions` the actor must hold each permission either unscoped or as a Project-parameterized authority; on the Platform require the actor to hold it runtime-wide (`actor.permissions` includes it or `*`), because the role can be assigned to any Project later.
- Assign: expand the proposed assignments for the target and run `canDelegateAccess` on the expanded access, plus the existing checks on direct access, inside `setAccountAccess`'s transaction.
- Delete: needs `system.roles.manage`; no delegation check (removing authority).

**Invariants.**
1. A principal's authority = direct access ∪ expansion of existing roles at authentication time.
2. No actor can create a role or assignment that gives authority the actor could not delegate directly; the check and the write are one transaction.
3. Every role change carries `expectedRevision` of the catalogue and raises it in the same transaction; at most 50 roles.
4. A missing role in an assignment expands to nothing; the next access edit drops it.

**Failure model.** NEW: `RoleInvalidError` 400 `invalid_role`; `RoleConflictError` 409 `role_revision_conflict`; `RoleLimitError` 429 `role_limit`; `RoleExpansionLimitError` 400 `role_expansion_limit`; `RoleNotFoundError` 404 `role_not_found`; delegation → 403 `account_access_forbidden`.

**Concurrency, bounds, interruption.** Role writes are one `documents.transaction` each (catalogue revision checked and raised, role row written, delegation checked); a crash leaves the old or new catalogue. Assignment writes use the existing conditional access write (`accessRevision`), which also ends the account's sessions. Authentication reads the cached catalogue; a role edit or delete takes effect on the member's next request in this runtime.

**Deleted.** Nothing. The fixed role label stays as is.

**Decisions and rejected alternatives.** One row per role plus a revision row over one catalogue document: an Auth transaction reads and writes rows, a role edit touches one row, and the revision row gives the same CAS. Changing a role does not end members' sessions: their authority is recomputed per request from the cache. Expansion at authentication over materialization: edits and deletes propagate without touching accounts. No inheritance: flat bundles are auditable.

**Decisions taken for the user.** Limits (50 roles, 10 assignments, 20 Projects per assignment). Apps use `project.users.manage` for role management. `SetAccountAccessInput.roleAssignments` is required (callers send `[]`).

**Needs from the user.** None.

## 3. Contracts

```ts
export const RoleDefinitionInputSchema = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,47}$/u)),
  title: Schema.String.check(Schema.isBetweenLength(1, 80), Schema.isPattern(/^[^\x00-\x1f\x7f]*$/u)),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  permissions: Schema.Array(PermissionSchema).check(Schema.isMaxLength(100)),
  grants: Schema.Array(GrantSchema).check(Schema.isMaxLength(100)),
  projectPermissions: Schema.Array(PermissionSchema).check(Schema.isMaxLength(100)),
  expectedRevision: Schema.Natural,         // catalogue revision
});
export const RoleAssignmentSchema = Schema.Struct({
  roleId: RoleDefinitionInputSchema.fields.id,
  projectIds: Schema.optional(Schema.Array(ProjectIdSchema).check(Schema.isMaxLength(20))),
});
// SetAccountAccessInputSchema gains: roleAssignments: Schema.Array(RoleAssignmentSchema).check(Schema.isMaxLength(10))
// AccountAccessResult gains roleAssignments. Invitation access gains roleAssignments (part 4 shape).
export interface RoleCatalogueView { readonly revision: number; readonly roles: readonly RoleDefinition[] }
```

| HTTP (relative to the API base) | Access | SDK | CLI (`--json`) |
| --- | --- | --- | --- |
| `GET /auth/roles` → `RoleCatalogueView` | `system.roles.manage` or `system.users.manage` (Platform); `project.users.manage` (App) | `client.auth.admin.roles()` | `zelavis auth roles` |
| `POST /auth/roles` → 201 `RoleCatalogueView` | `system.roles.manage` / `project.users.manage` + delegation | `client.auth.admin.createRole(input)` | `zelavis auth create-role --data JSON` |
| `PUT /auth/roles/:roleId` (same body, `id` must match) → 200 | same | `client.auth.admin.updateRole(roleId, input)` | `zelavis auth update-role ROLE --data JSON` |
| `DELETE /auth/roles/:roleId?revision=N` → 200 | `system.roles.manage` / `project.users.manage` | `client.auth.admin.deleteRole(roleId, expectedRevision)` | `zelavis auth delete-role ROLE --revision N` |
| `GET\|POST /runtime/projects/:projectId/auth/roles`, `PUT\|DELETE …/:roleId` | `project.users.manage` on the Project | `client.projects.roles(id)`, `.createRole(id, input)`, `.updateRole(id, roleId, input)`, `.deleteRole(id, roleId, rev)` | `zelavis projects roles PROJECT`, `create-role PROJECT --data JSON`, `update-role PROJECT ROLE --data JSON`, `delete-role PROJECT ROLE --revision N` |

Add `system.roles.manage` to the permission vocabulary shown on `/server/access/permissions` (`host-pages.ts:240`, `VOCABULARY`). Dashboard routes NEW `/server/access/roles` and `/projects/:projectId/roles`.

## 4. Execution steps

### 1. Prove the access baseline at HEAD

- **Files**: none.
- **Depends on**: part 5 landed.
- **Check**: build; `pnpm --filter zelavis exec node --test --test-reporter=dot test/auth-admin.test.mjs test/auth-invitations.test.mjs test/platform-gateway-authority.test.mjs; echo "exit $?"` prints `exit 0`.

### 2. Add the roles module tables

- **Files**: NEW `packages/zelavis/src/auth/roles/{tables,roles}.ts`; `auth/accounts/tables.ts` (`roleAssignments`); `auth/create-auth.ts` (register the module's tables); `auth/README.md` (row for `roles/*`, Zelavis-own); NEW `packages/zelavis/test/auth-roles.test.mjs` over `test/_auth.mjs`.
- **Change**: tables and schemas per sections 2-3; `roles.ts` exports `listRoles(tx)`, `createRole(tx, actor, input)`, `updateRole(tx, actor, roleId, input)`, `deleteRole(tx, roleId, expectedRevision)`, each checking and raising the catalogue revision. A stored row that does not decode fails closed: expansion skips that role, the role routes answer 503 `roles_unavailable`, and one log line names the collection and row id (no content). Add that code to the failure table.
- **Depends on**: 1.
- **Check**: rebuild; `auth-roles.test.mjs`: 16 concurrent creates against one revision through the harness → exactly one success, the others `role_revision_conflict`.

### 3. Expand role assignments into principals

- **Files**: NEW `auth/roles/{expand,cache}.ts`; `auth/accounts/principal.ts` (takes expanded access); `auth/core/authenticator.ts` (cache); `auth/access/delegation.ts` (`resolveActor` expands through `tx.db`); `auth/invitations/accept.ts` (inviter expansion through `tx.db`); `test/auth-roles.test.mjs`.
- **Change**: section 2 expansion; the authenticator expands from the cache, transactions read roles through `tx.db`.
- **Depends on**: 2.
- **Check**: rebuild; expansion unit cases and "edit propagates on the next request without touching the account" pass.

### 4. Add role assignments to account access and invitations

- **Files**: `auth/access/access.ts` (`delegatedAccessFields` gains required `roleAssignments`; `normalizeAccountAccess` sorts them; `projectAccountAccessDigest` and `projectAccountAccessPermissions` cover them); `auth/access/delegation.ts` (`setAccountAccess`, `canDelegateAccess` on expanded access); `auth/invitations/invitations.ts`; `auth/routes/admin.ts` (result carries `roleAssignments`); `packages/zelavis/src/platform/project-gateway.ts` (account access route); `packages/zelavis/src/sdk/auth-client.ts` (types); dashboard `app/account-access-editor.ts` (send `roleAssignments`, preserve existing ones).
- **Change**: required field; delegation on expanded access; the Gateway refuses `projectIds` on App assignments (the App's own Project is implicit).
- **Depends on**: 3.
- **Check**: rebuild; `pnpm --filter zelavis exec node --test test/auth-admin.test.mjs test/auth-invitations.test.mjs test/auth-roles.test.mjs; echo "exit $?"` prints `exit 0`; `pnpm run typecheck; echo "exit $?"` prints `exit 0`.

### 5. Add the role routes

- **Files**: NEW `auth/routes/roles.ts` (mounted beside `defineAdminRoutes` in `auth/create-auth.ts`); `auth/routes/admin.ts` (error codes shared through its table, or the new file's own table in the same style).
- **Depends on**: 4.
- **Check**: rebuild; HTTP cases in `auth-roles.test.mjs` pass.

### 6. Add the exact Project Gateway routes

- **Files**: `packages/zelavis/src/platform/project-gateway.ts` (beside `runtime.projects.auth.accounts.access.set` and the invitation routes); `test/auth-roles.test.mjs`; `test/platform-gateway-authority.test.mjs` (route inventory).
- **Change**: forward the four App role routes with `project.users.manage`, checking delegation of the role content against the caller's Project authority and signing the permission digest as the access route does.
- **Depends on**: 5.
- **Check**: rebuild; Gateway cases pass.

### 7. Add SDK and CLI parity

- **Files**: `packages/zelavis/src/sdk/auth-client.ts` (`client.auth.admin.*`), the Project methods beside `client.projects.invitations` (`packages/zelavis/src/sdk/fetch.ts`); `packages/zelavis/src/cli/auth-operations.ts`; `packages/zelavis/src/cli/projects.ts`.
- **Depends on**: 6.
- **Check**: rebuild; `pnpm --filter zelavis exec node --test test/capability-parity.test.mjs; echo "exit $?"` prints `exit 0`.

### 8. Add the dashboard Roles pages and the editor's role picker

- **Files**: NEW `packages/zelavis/services/zelavis-ui/app/roles-page.ts`; `app/host-pages.ts` (route `/server/access/roles`, vocabulary entry); the Project users area (route `/projects/:projectId/roles`); `app/navigation-menu.ts` (menu entries, filtered by `canAccess`); `app/account-access-editor.ts` (role multi-select with Project picker); `app/dashboard-routes.ts`; `scripts/test-route-parity.mjs`.
- **Change**: list, create, edit (revision conflict message), delete with typed confirmation of the role id.
- **Depends on**: 7.
- **Check**: `pnpm --filter @zelavis/ui typecheck; echo "exit $?"`, `pnpm --filter @zelavis/ui test; echo "exit $?"`, `pnpm run ci:ui; echo "exit $?"`; all `exit 0`.

### 9. Document custom roles

- **Files**: `website/src/content/docs/architecture/access-control.md`, `website/src/content/docs/packages/auth.md`.
- **Depends on**: 8.
- **Check**: `pnpm run docs:check; echo "exit $?"` prints `exit 0`.

### 10. Self-audit

- **Check**: `pnpm run verify; echo "exit $?"`, `pnpm run ci:ui; echo "exit $?"`, `git diff --check; echo "exit $?"`; all `exit 0`.

## 5. Tests

`test/auth-roles.test.mjs` (Auth harness `test/_auth.mjs` for concurrency and expansion; Platform with Projects P, Q, R created through the test Platform helper in `./_runtime.mjs`; an App runtime):
- Owner defines `project-developer` (`projectPermissions: ["project.view", "project.domains.manage"]`); assigns to customer C for P and Q; C's `GET /runtime/projects` lists P and Q only; C adds a domain to P (with a DNS fixture from part 1 or the injected resolver) → allowed; R → 403.
- Owner edits the role to drop `project.domains.manage`; C's next domain call → 403; C's account record unchanged (`accessRevision` same).
- Delete role → C sees no Projects; next access edit of C drops the dangling assignment.
- Operator without `project.domains.manage` runtime-wide cannot create a role containing it → 403; cannot assign an owner-defined role containing it → 403.
- Expansion limit: 10 assignments × 20 Projects × a 100-permission role → 400 `role_expansion_limit`.
- Catalogue CAS conflict → 409; 51st role → 429.
- Reserved ids `owner`, `customer` → 400.
- App: through the Gateway define `reader` with `permissions: ["database.read"]`, assign it to an App user, and assert that user's App principal has `database.read` scoped to the App's Project; an App role with non-empty `projectPermissions` or `grants` → 400 `invalid_role`.
- Gateway: caller with `project.users.manage` on Q cannot manage P's roles.
- Parity: SDK and CLI match HTTP.

Browser (`scripts/test-route-parity.mjs`, both sizes): create a role on `/server/access/roles`, assign it to a customer in the access editor with one Project, wait for "Access saved.", sign in as the customer in a second context and see that Project.

## 6. Docs and project notes

`website/src/content/docs/architecture/access-control.md`, `packages/auth.md`. No `pnotes/TODO.md` additions.

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
> Forbidden in this project: compatibility aliases, legacy fallbacks or shims; silent catch handlers, `Effect.ignore`/`Effect.ignoreCause`; literal unlimited Effect concurrency; unchecked `JSON.parse` casts; new `async` functions, `new Promise` or Promise coordination in Platform code, and any growth of `scripts/effect-migration-baseline.json`; `node:` imports outside `src/adapters` (and the CLI); the `effect` barrel in files the Project persistent host loads; React for a dashboard page; edits to `dist/`, `website/dist/`, `website/.astro/` or `repos/effect/`; anything written in `.claude/`; additions to `pnotes/TODO.md`; per-account or per-role reads on the authentication hot path. Never edit generated output. Do not commit, push or publish unless told to.
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

### Session 1: 2026-11-16

Final status: done. Steps 1-10 carried out in the main checkout on `dev`; nothing committed.

- 1 done: build plus `auth-admin`, `auth-invitations`, `platform-gateway-authority` passed at the starting tree.
- 2 done: NEW `auth/roles/tables.ts` (`roles_catalogue` revision row, `roles_roles` rows with `by_roleId`), `auth/roles/catalogue.ts` (schemas, `readCatalogue`, decode that skips and logs an undecodable row), `auth/roles/roles.ts` (`createRole`, `updateRole`, `deleteRole`, `listRoles`, delegation of role content); `accounts_accounts.roleAssignments` optional; module registered in `create-auth.ts`; README row. Security event kinds `role.created|changed|deleted`.
- 3 done: NEW `auth/roles/expand.ts` (`expandAccountAccess`, `expansionSize`, `ROLE_EXPANSION_LIMIT`), `auth/roles/cache.ts` (`RoleCatalogueCache` with a generation counter so a load racing a change is not kept); `accountSessionPrincipal` takes the catalogue; the authenticator loads the copy only for accounts holding assignments; `resolveActor`, `managedAccount`, invitation creation and acceptance read roles through `tx.db`.
- 4 done: `roleAssignments` required in `DelegatedAccess`/`SetAccountAccessInput`, in the result and the account listing; `normalizeAccountAccess` sorts it; `projectAccountAccessPermissions` and the digest cover role permissions; `setAccountAccess` checks expanded current and proposed access, refuses a new unknown role (`role_not_found`), drops a dangling kept one, and enforces 2000 entries; App assignments carry no `projectIds` (`accessInputFits`); Platform assignments' Projects go through `validateGrantScopes`; invitations merge assignments at acceptance. All existing callers and tests now send `roleAssignments: []`.
- 5 done: NEW `auth/routes/roles.ts` (four routes, its own refusal table, cache cleared after every change, Gateway digest check).
- 6 done differently: besides the four exact App role routes, the Gateway now reads the App's catalogue (`readProjectRoles`) for an access edit or invitation that involves roles and for a role update (old content), so its signed permission names include role permissions; the child recomputes them from its own catalogue.
- 7 done: `client.auth.admin.roles|createRole|updateRole|deleteRole`, `client.projects.roles|createRole|updateRole|deleteRole`, `zelavis auth roles|create-role|update-role|delete-role`, `zelavis projects roles|create-role|update-role|delete-role`; capability-parity gained a role case; the Gateway route inventory in `zelavis-server.test.mjs` lists the new routes.
- 8 done: NEW `app/roles-page.ts` (list, create, edit with the revision-conflict message, delete after typing the id) at `/server/access/roles` (server navigation item) and `/projects/:projectId/roles` (project menu, managed apps too); role picker with Project choice in `account-access-editor.ts`; vocabulary entries; browser scenario `qualifyCustomRoles` in `scripts/test-embedded-server-views.mjs` (both sizes, create, assign for one Project, customer sees exactly that Project, typed deletion). The plan named `scripts/test-route-parity.mjs`; it visits the new routes automatically from `dashboard-routes.ts`, and the action scenario went beside the existing access-editor scenarios instead.
- 9 done: `architecture/access-control.md` (Custom roles), `packages/auth.md` (Custom roles, invitation body), `api/platform-operations.md`, `packages/zelavis/README.md` (also corrected the SDK/CLI names it gave for access edits), `AGENTS.md § Zelavis Auth` module list gains `roles`.
- 10 done: self-audit below.

Verification (after the last edit, `TMPDIR=/private/tmp/zelavis-verify`): `pnpm run verify` exit 0 (3569 tests pass, 0 fail; TigerStyle, Effect usage and repo rules pass); `pnpm run ci:ui` exit 0, including the new "Custom roles" scenario (a first run failed on the delete confirmation's accessible name; fixed by letting the visible label name the input, then rerun green); `pnpm run docs:check` exit 0; `git diff --check` exit 0. Focused runs during the work: `auth-roles.test.mjs` 10/10; all `auth-*`, Gateway, parity, server and host-footprint suites 492/492.

Deviations:
- `RoleDefinition` views use `id` (matching the input's `id`) rather than the plan's storage field name `roleId`; rows store `roleId` and the content as one decoded value (`definition`), so an undecodable row is skipped instead of failing every read of the table, authentication included.
- A role edit is refused unless the actor could also delegate the content it replaces (the plan required only the new content), mirroring `setAccountAccess`'s current-and-proposed check, so an operator cannot strip a role the owner built.
- Creating a role whose id exists answers 409 `role_exists` (code not in the plan's table).
- Invitation acceptance that would push an existing account past 10 assignments or 20 Projects answers 409 `invitation_access_limit` and leaves the invitation pending.
- The 2000-entry expansion bound is checked at assignment (access edit, invitation). A later role edit that grows members' expansion is not re-checked per member (that would be a per-account scan); expansion stays bounded by 10 × (100 + 20 × 100).

Decisions taken for the user:
- A new assignment naming a role that does not exist is refused (`role_not_found`) rather than silently dropped; only an assignment the account already held is dropped when its role is gone (invariant 4).
- Deleting a role leaves the assignment on accounts until their next access edit, as the plan specifies, so recreating a role with the same id gives its authority back to those accounts; the docs and the delete confirmation say so. Tombstoning deleted ids was not added (unbounded state).
- Platform user administrators with `system.users.manage` can read the catalogue (needed to assign), never change it.

Added items: none.
