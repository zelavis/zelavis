# Account invitations

Job: Let an authorized user invite an email address into the Platform or one App with preset access, delivered by email and accepted once, even while public registration is closed.
Date: 2026-11-13
Status: planned
Verified-at: b04fa02d95
Part: 4 of 10. Read 00-overview.md first.

To start:    Execute part 4 in .agents/plans/2026-11-13-accounts-billing-domain-automation/04-account-invitations.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-13-accounts-billing-domain-automation/04-account-invitations.md. Start with its section 8.

## Progress

- [ ] 1. Confirm parts 2-3 handover and the baseline.
- [ ] 2. Add the invitation repository on all backends.
- [ ] 3. Add the invitation service.
- [ ] 4. Expose invitation routes on every runtime.
- [ ] 5. Add the exact Project Gateway routes.
- [ ] 6. Add SDK and CLI parity.
- [ ] 7. Add the dashboard invite and accept pages.
- [ ] 8. Add the App site accept page.
- [ ] 9. Document invitations.
- [ ] 10. Self-audit.

## 0. Summary and finish line

Today an owner can only grant access to accounts that already exist (`PUT /auth/accounts/:accountId/access`, `packages/zelavis/src/app/identity/identity-service.ts:427-455`), so a customer must first sign up, which needs public registration open. This part adds invitations: an authorized user names an email address and the access to give (role, permissions, concrete grants) within what they could delegate today; the invitee gets an email link; accepting creates the account (password credential) or, when an account with that email exists and is signed in, adds the access to it. Acceptance proves the inbox, so the account is verified.

- **In scope**: invitation records with single-use tokens, create/list/revoke/accept, delegation checks at creation and (for same-runtime inviters) at acceptance, enrollment through the existing slot machinery while registration is closed, Platform and App runtimes, the Project Gateway, SDK, CLI, dashboard, App site, docs, tests.
- **Out of scope**: organizations or teams, bulk CSV invites, invitation by username, custom roles in invitations (part 6 adds `roleAssignments` to access everywhere, including invitations).
- **Done means**: (a) a Platform owner invites `a@example.com` as `customer` with `project.view` on Project P; the email arrives; accepting with a password creates exactly one account with that access and `verified: true`, with registration closed; (b) accepting twice concurrently creates one account; (c) a revoked, expired or used invitation is refused with one generic error; (d) an inviter who lost the delegated authority before acceptance makes the invitation unusable; (e) an invitee whose email already has an account must sign in as that account to accept, and the access is merged; (f) App invitations through the Gateway need `project.users.manage` on that exact Project; (g) parity, browser, `verify`, `ci:ui`, `docs:check` pass.
- **Supplement**: updated in this run (overview section 0).
- **Sources read**: `AGENTS.md § Core Access-Control Rule`, `§ Endpoint-Backed Capability Rule`; parts 2-3; files below.

## 1. Context packet

**Glossary.**
- **Invitation**: a stored offer of access to one email address, with a single-use token sent by email.
- **Inviter**: the principal that created it: an account of the same runtime, or (App invitations through the Gateway) a Platform principal.
- **Access**: `{ role, permissions, grants }` exactly as `SetAccountAccessInput` minus `expectedRevision` (`packages/zelavis/src/app/identity/domain/account-access.ts:32-40`).

**Governing rules.**
> "Unscoped and system grants authorize runtime-wide routes. Project and service grants require the same explicit route identity and never satisfy an unscoped requirement" `AGENTS.md § Core Access-Control Rule`
>
> "Approval is a second gate that re-authorizes at decision time" `AGENTS.md § Endpoint-Backed Capability Rule` (Assistant approvals; the same principle applies to acceptance).

**System today.**
- Delegation check `assertCanDelegateAccountAccess(actor, context, access, provedProjectPermissions?)` `packages/zelavis/src/app/identity/services/account-service.ts:75-104`; roles a caller may give `canDelegateRole` `:69-72`; `AccountAdministrationContext` `:38-42`.
- Access write `AccountService.setAccess` `account-service.ts:171`; route `identity-service.ts:427-455` (`system.users.manage` / `project.users.manage`, `managePermission` at `:329-331`).
- Human roles: Platform `customer|operator|reseller`, App `user` (`identity-service.ts:413`; schema `account-access.ts:21`).
- Enrollment with slots: `RegistrationService.enroll` `packages/zelavis/src/app/identity/services/registration-service.ts:399-459`; the open-policy gate is at `:268-281` and `:310`.
- Gateway account access route `packages/zelavis/src/platform/project-gateway.ts:718-760`: decodes, checks every grant is for the exact Project and delegable by the caller (`principalHasPermission`), reads current authority from the child, then forwards with a signed permission digest (`projectAccountAccessDigest`, `account-access.ts:97-102`; proof binding `:73-78`).
- Part 3 handover: `AccountTokenRepository` with `consume` (`contracts/repositories.ts`), `CredentialProviderApi.tokens`, `AccountMessagesPort` (`services/account-messages.ts`). Part 2: `EmailOutbox`.

**Pattern to mirror.** The Gateway account access route for proving delegated Project permissions. Part 3's recovery flow for issue, email, consume.

**Traps.**
- Letting an invitation bypass delegation: check at creation with the same function as access edits.
- Merging into an existing account without its owner signed in: anyone who controls the mailbox could attach access to someone else's account only if the email matches; still require the account's own session so a stale address cannot be hijacked.
- Creating the account outside the enrollment slots: crash recovery and limits live there.
- Listing pending invitations by scanning all accounts: invitations are their own bounded records.

## 2. Design

**Authority and scope.** Invitations live in the runtime's identity repositories. Create/list/revoke need `system.users.manage` (system scope) on the Platform and `project.users.manage` (its Project) in an App; the Gateway exposes exact App routes with `project.users.manage` on the route's Project. Accept is public (the token is the authority) plus, for an existing account, that account's session.

**Persistence.** **NEW** `InvitationRepository` on `IdentityRepositories.invitations`:

```ts
export interface Invitation {
  id: string;                         // UUID
  email: string;                      // normalized lowercase
  access: { role: HumanAccountRole; permissions: readonly string[]; grants: readonly ConcreteAccountGrant[] };
  invitedBy: { kind: "account"; accountId: string } | { kind: "gateway"; principalId: string };
  tokenHash: string;                  // part 3 token, purpose "invitation"
  status: "pending" | "accepted" | "revoked";
  acceptedAccountId?: string;
  createdAt: Date; expiresAt: Date; updatedAt: Date;
}
export interface InvitationRepository {
  create(invitation: Invitation): Promise<Invitation>;          // fails IdentityConflictError when 500 pending exist (counter record)
  mutate(id: string, mutation: Mutation<Invitation>): Promise<Invitation | null>;
  findById(id: string): Promise<Invitation | null>;
  page(options: { limit: number; after?: string }): Promise<{ invitations: Invitation[]; next?: string }>;
}
```

The token is a part 3 `AccountToken` with purpose `"invitation"` (add the literal) and a NEW optional field `invitationId`. Expiry 7 days. At most 500 pending per runtime (a counter record updated by CAS on create and on every transition out of `pending`; the hourly sweep that marks expired ones recounts in pages of 200).

**Flows.**
1. *Create* `POST /auth/invitations { email, access }`: validate with the access schema; `assertCanDelegateAccountAccess(actor, context, access)`; email must be configured (`EmailOutbox.linkBase()` defined, else 409 `email_disabled`); refuse an email that already has a **pending** invitation in this runtime? No index exists by email, so allow duplicates; each is independent. Issue token, create record, enqueue `invitation` email with `<linkBase>/invitation#token=…` naming the inviter's display name and the runtime. Answer `201 Invitation` (public view without `tokenHash`).
2. *Revoke* `DELETE /auth/invitations/:id`: `mutate` pending → revoked. Its token stays and is refused at accept because the invitation is not pending.
3. *Accept* `POST /auth/invitations/accept { token, password?, displayName? }`:
   a. `consume(tokenHash, "invitation")` → token (else 400 `invalid_invitation`);
   b. load invitation; must be `pending` and unexpired (else 400 `invalid_invitation`);
   c. if `invitedBy.kind === "account"`: rebuild the inviter's principal from the stored account with `accountSessionPrincipal` (`packages/zelavis/src/app/identity/core/session-authenticator.ts:48`) and rerun `assertCanDelegateAccountAccess`; failure → mark revoked, 400 `invalid_invitation`;
   d. existing account with that email: require the request's session principal id to equal it (else 409 `invitation_requires_sign_in` with no account detail); merge access via the access writer (union of permissions and grants, role kept unless the account's role is `customer`/`user` and the invitation's role is higher, which the delegation check already allowed); set `verified: true`;
   e. no account: require `password`; enroll through `RegistrationService.enroll` with a new admission mode `"invitation"` that skips the open-policy check but keeps slots, rate limits and crash recovery; create with `verified: true` and the invitation's access;
   f. `mutate` invitation pending → accepted with `acceptedAccountId`; issue a session as signup does; answer `200 ZelavisAuthSessionResult`.
   A crash after (a) and before (f) leaves the token consumed and the invitation pending: the inviter resends (NEW `POST /auth/invitations/:id/resend` issues a new token, CAS on the invitation, enqueues again).
4. *List* `GET /auth/invitations?limit&after`: pending first is not required; return pages in key order with status.

**Gateway (App invitations).** `POST /runtime/projects/:projectId/auth/invitations` checks, like `project-gateway.ts:718-760`, that `access.role === "user"`, `permissions` is empty, every grant is for this Project and delegable by the caller, then forwards with the signed permission digest and `invitedBy: { kind: "gateway", principalId }`. Acceptance-time re-authorization does not apply to gateway inviters (the child cannot rebuild a Platform principal); the 7-day expiry and revocation bound it. Documented.

**Invariants.**
1. One token, one acceptance (part 3 `consume`).
2. Invitation access ⊆ what the inviter could delegate at creation, and (account inviters) at acceptance.
3. Acceptance never adds access to an account without that account's own session.
4. Pending invitations ≤ 500 per runtime.

**Failure model.** NEW tags: `InvitationInvalidError` → 400 `invalid_invitation` (one message for unknown, used, revoked, expired, de-authorized); `InvitationRequiresSignInError` → 409 `invitation_requires_sign_in`; `InvitationLimitError` → 429 `invitation_limit`; email disabled → 409 `email_disabled`; delegation → 403 `account_access_forbidden` (existing code). Registered in `authErrorResponse`.

**Decisions and rejected alternatives.** Reuse part 3 tokens rather than a token inside the invitation record: one consume primitive. Allow duplicate pending invitations per email: an email index would be another unique-claim structure for little value. Merge rather than replace on existing accounts: invitations add access; removing access stays an explicit access edit.

**Decisions taken for the user.** 7-day expiry, 500 pending per runtime, acceptance verifies the email, gateway invitations are not re-authorized at acceptance.

**Needs from the user.** None.

## 3. Contracts

```ts
export const CreateInvitationInputSchema = Schema.Struct({
  email: Address,                                         // same Address schema as part 2
  access: Schema.Struct({ role: RoleSchema, permissions: SetAccountAccessInputSchema.fields.permissions, grants: SetAccountAccessInputSchema.fields.grants }),
});
export const AcceptInvitationInputSchema = Schema.Struct({
  token: Schema.String.check(Schema.isBetweenLength(43, 43)),
  password: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
  displayName: Schema.optional(Schema.String.check(Schema.isBetweenLength(1, 100))),
});
export interface PublicInvitation {
  readonly id: string; readonly email: string; readonly access: Invitation["access"];
  readonly status: Invitation["status"]; readonly createdAt: string; readonly expiresAt: string; readonly acceptedAccountId?: string;
}
```

| HTTP (relative to the API base) | Access | SDK | CLI (`--json`) |
| --- | --- | --- | --- |
| `GET /auth/invitations?limit=1..100&after=` → `{ invitations: PublicInvitation[], next? }` | users permission | `client.auth.admin.invitations({ limit?, after? })` | `zelavis auth invitations [--limit N] [--after C]` |
| `POST /auth/invitations` → 201 `PublicInvitation` | users permission + delegation | `client.auth.admin.invite(input)` | `zelavis auth invite --data JSON` |
| `POST /auth/invitations/:id/resend` → 202 | users permission | `client.auth.admin.resendInvitation(id)` | `zelavis auth resend-invitation ID` |
| `DELETE /auth/invitations/:id` → 200 `PublicInvitation` | users permission | `client.auth.admin.revokeInvitation(id)` | `zelavis auth revoke-invitation ID` |
| `POST /auth/invitations/accept` → 200 session result | public (+ session for existing accounts) | `client.auth.acceptInvitation(input)` | `zelavis auth accept-invitation --data JSON` |
| `GET\|POST /runtime/projects/:projectId/auth/invitations`, `POST …/:id/resend`, `DELETE …/:id` | `project.users.manage` on the Project | `client.projects.invitations(id, page?)`, `.invite(id, input)`, `.resendInvitation(id, invitationId)`, `.revokeInvitation(id, invitationId)` | `zelavis projects invitations PROJECT`, `invite PROJECT --data JSON`, `resend-invitation PROJECT ID`, `revoke-invitation PROJECT ID` |

"users permission" = `system.users.manage` (system) / `project.users.manage` (its Project). App public allowlist adds `POST /auth/invitations/accept` and page `/invitation`. Platform public page `/invitation`. Bodies ≤ 32 KiB (create) and 4 KiB (accept).

## 4. Execution steps

### 1. Confirm parts 2-3 handover and the baseline

- **Goal**: tokens, messages and outbox exist; identity suites pass.
- **Files**: none.
- **Change**: `rg -n "consume\(tokenHash" packages/zelavis/src/app/identity/contracts/repositories.ts` and `rg -n "AccountMessagesPort" packages/zelavis/src/app/identity` find them; read parts 2-3 execution reports.
- **Depends on**: parts 2, 3.
- **Check**: build; `pnpm --filter zelavis exec node --test --test-reporter=dot test/identity-recovery.test.mjs test/identity-account-access.test.mjs test/identity-atomicity.test.mjs; echo "exit $?"` prints `exit 0`.

### 2. Add the invitation repository on all backends

- **Goal**: `invitations` repository per section 2 with the pending counter.
- **Files**: `packages/zelavis/src/app/identity/domain/entities.ts`, `contracts/repositories.ts`, `storage/in-memory.ts`, `storage/database.ts`, `packages/zelavis/src/platform/auth-repositories.ts`; `packages/zelavis/test/identity-atomicity.test.mjs`.
- **Change**: implement with the backends' existing CAS helpers; keys `invitation:<id>` and `invitation-count` in the System Store namespace. Add `"invitation"` to the token purpose union and `invitationId?` to `AccountToken`.
- **Depends on**: 1.
- **Check**: rebuild; atomicity tests (section 5) pass with `pnpm --filter zelavis exec node --test test/identity-atomicity.test.mjs; echo "exit $?"`.

### 3. Add the invitation service

- **Goal**: create, resend, revoke, accept and sweep per section 2.
- **Files**: **NEW** `packages/zelavis/src/app/identity/services/invitation-service.ts`; `services/registration-service.ts:268-281`, `:399-459` (admission mode `"invitation"`); `core/create-identity.ts` (wire the service onto `IdentityApi` as `invitations`); `core/errors.ts`; `services/account-messages.ts` (invitation message); **NEW** `packages/zelavis/test/identity-invitations.test.mjs`.
- **Change**: implement with `Effect.gen` internally and the identity's existing Promise-facing API style (as `AccountService`). Merge for existing accounts goes through `AccountService`'s conditional access write.
- **Depends on**: 2.
- **Check**: rebuild; `pnpm --filter zelavis exec node --test test/identity-invitations.test.mjs; echo "exit $?"` prints `exit 0`.

### 4. Expose invitation routes on every runtime

- **Goal**: section 3 HTTP routes in `identity-service.ts`.
- **Files**: `packages/zelavis/src/app/identity/identity-service.ts` (beside `:427-455`); `packages/zelavis/src/platform/project-public-auth.ts:11-17`.
- **Change**: routes `auth.invitations.list|create|resend|revoke|accept` with `manageAccess` (`identity-service.ts:335-340`) for admin routes; accept sets the session cookie as signup does (`:611-619`).
- **Depends on**: 3.
- **Check**: rebuild; `identity-invitations.test.mjs` HTTP cases pass.

### 5. Add the exact Project Gateway routes

- **Goal**: Platform principals invite App users to exactly one App.
- **Files**: `packages/zelavis/src/platform/project-gateway.ts` (beside `accountAccessRoute`, `:718`); `packages/zelavis/test/identity-invitations.test.mjs`.
- **Change**: mirror `accountAccessRoute`'s checks and signed digest; the child accepts `invitedBy: { kind: "gateway" }` only from a Gateway-signed request (follow how the child verifies the account-access digest; find with `rg -n "projectAccountAccessProof" packages/zelavis/src`).
- **Depends on**: 4.
- **Check**: rebuild; Gateway cases pass.

### 6. Add SDK and CLI parity

- **Goal**: section 3 SDK and CLI.
- **Files**: `packages/zelavis/src/sdk/fetch.ts` (`ZelavisAuthClient.admin` `:373-380`, implementation `:2280+`, Project methods near `:1568`); `packages/zelavis/src/cli/auth-operations.ts`; `packages/zelavis/src/cli/projects.ts` (usage `:10`, positional `:146`, `--data` gate `:170`).
- **Depends on**: 5.
- **Check**: rebuild; `pnpm --filter zelavis exec node --test test/capability-parity.test.mjs test/identity-invitations.test.mjs; echo "exit $?"` prints `exit 0`.

### 7. Add the dashboard invite and accept pages

- **Goal**: invite from Server → Access → Users and Project → Users; accept at `/invitation`.
- **Files**: `packages/zelavis/services/zelavis-ui/app/host-pages.ts:244` (`accessUsersScreen`: "Invite" form reusing `account-access-editor.ts` choices `:24-29`, pending list with Resend and Revoke); the Project users screen (find with `rg -n '"/projects/:projectId/users"' packages/zelavis/services/zelavis-ui/app` and its screen); `app/auth-pages.ts` (NEW `invitationScreen`); `src/auth-routes.ts:2`; `app/dashboard-routes.ts` (add `"/invitation"`); `scripts/test-embedded-server-views.mjs`.
- **Change**: `/invitation` reads `#token=`, clears it, shows "Create your password" (new) or "Sign in to accept" (on `invitation_requires_sign_in`), posts accept, then navigates to `/projects`.
- **Depends on**: 6.
- **Check**: `pnpm --filter @zelavis/ui typecheck; echo "exit $?"`, `pnpm --filter @zelavis/ui test; echo "exit $?"`, `pnpm run ci:ui; echo "exit $?"`; all `exit 0`.

### 8. Add the App site accept page

- **Goal**: `/invitation` on App origins.
- **Files**: `packages/zelavis/services/zelavis-ui/src/identity-frontend-service.ts:7`; `app/identity-site.ts:12`; `scripts/test-embedded-server-views.mjs`.
- **Depends on**: 7.
- **Check**: as step 7.

### 9. Document invitations

- **Files**: `website/src/content/docs/packages/auth.md`, `website/src/content/docs/architecture/access-control.md`.
- **Change**: flows, delegation rule, merge rule, gateway limit, expiry, all three transports.
- **Depends on**: 8.
- **Check**: `pnpm run docs:check; echo "exit $?"` prints `exit 0`.

### 10. Self-audit

- **Change**: section 8 self-audit list.
- **Check**: `pnpm run verify; echo "exit $?"`, `pnpm run ci:ui; echo "exit $?"`, `git diff --check; echo "exit $?"`; all `exit 0`.

## 5. Tests

`test/identity-invitations.test.mjs` (Platform via `platform` from `./_runtime.mjs` and an App runtime; SMTP fixture or recording outbox):
- Owner invites `a@example.com` as `customer` with `project.view` on P while registration is closed; message link `<linkBase>/invitation#token=…`; accept with password → 200 session; account has that access and `verified: true`; `GET /runtime/projects` shows P only.
- Concurrent accept ×8 → one 200, the rest 400 `invalid_invitation`; one account exists.
- Revoked → 400; expired (injected clock) → 400; used → 400; bodies identical.
- Operator with only `project.view` on P invites with `project.domains.manage` on P → 403 `account_access_forbidden`.
- Inviter's own access removed between create and accept → 400 and status `revoked`.
- Existing account: accept without session → 409 `invitation_requires_sign_in`; signed in as another account → 409; signed in as that account → access merged, revision bumped.
- Limit: 500 pending → 501st 429 `invitation_limit`.
- Email disabled → 409 `email_disabled`.
- Gateway: Platform operator with `project.users.manage` on P invites an App user to P; a grant for Q → 403; another Project's grant on the caller → 403.
- Parity: SDK and CLI match HTTP for create, list, revoke and accept.

`test/identity-atomicity.test.mjs`: invitation `mutate` linearizable; counter never exceeds 500 under 32 concurrent creates.

Browser (`scripts/test-embedded-server-views.mjs`, both sizes): owner invites from Users, the fixture receives the email, a fresh context opens the link, sets a password, lands on Projects showing only the granted Project. Wait for "Invitation sent." before reading the fixture.

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
> Forbidden in this project: compatibility aliases, legacy fallbacks or shims; silent catch handlers, `Effect.ignore`/`Effect.ignoreCause`; literal unlimited Effect concurrency; unchecked `JSON.parse` casts; new `async` functions, `new Promise` or Promise coordination in Platform code, and any growth of `scripts/effect-migration-baseline.json`; `node:` imports outside `src/adapters` (and the CLI); the `effect` barrel in files the Project persistent host loads; React for a dashboard page; edits to `dist/`, `website/dist/`, `website/.astro/` or `repos/effect/`; anything written in `.claude/`; additions to `pnotes/TODO.md`; tokens or passwords in logs, responses, URLs sent to a server, or security events. Never edit generated output. Do not commit, push or publish unless told to.
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
