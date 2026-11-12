# Operator registration controls and Platform signup

Job: Give owners registration switches and give Platform customers a public signup and normal login flow.
Date: 2026-11-10
Status: complete
Verified-at: f30953612f
Part: 3 of 5. Read 00-overview.md first.
To start:    Execute the plan in .agents/plans/2026-11-10-platform-app-self-registration/03-dashboard-registration-controls.md. Start with its section 8.
To continue: Continue the plan in .agents/plans/2026-11-10-platform-app-self-registration/03-dashboard-registration-controls.md. Start with its section 8.

## Progress

- [x] 1. Prove the starting Fuzor and embedded browser baseline.
- [x] 2. Add Platform and Project registration controls.
- [x] 3. Add the public Platform signup view.
- [x] 4. Present customer and App access safely.
- [x] 5. Document the browser workflows.
- [x] 6. Self-audit.

## 0. Summary and finish line

Add a live operator control to the existing Platform Auth service page and the native Project Auth screen. The existing Fuzor login links to a public signup page when core allows enrollment. Authorized admins can edit an account's roles and grants from existing Users screens. Newly signed-in customers see the scoped Projects view from Part 2.

- **In scope** — registration UI, signed-out Platform route, owner/customer UI and conditional access edits.
- **Out of scope** — publishing native App auth routes on customer origins, domain onboarding and commercial fulfillment.
- **Done means** — a Playwright run proves the operator can open and close signup, a new customer signs up and signs in through the real bundle, scoped UI stays usable, and both Platform and Project operator forms call the correct endpoints.
- **Supplement** — existing supplement with focused-test cwd correction. Parts 1 and 2 supply registration settings/status and conditional account access operations. Confirm their tests and execution reports before editing.
- **Sources read** — `AGENTS.md:1701`, `:2202`, `:2300`, the plan-writer, core platform and dashboard UI skills, the UI README and source below.

## 1. Context packet

**Glossary.** Fuzor owns the bundled dashboard shell and native route pages. The Auth settings service is the bundled product plugin that contributes an origin-trusted Platform settings page. The App Auth screen is a native dashboard page for one selected child. The signup form is a browser client of public Identity, and an access editor is a client of the administrative account update.

> “The dashboard is a client of Zelavis, not the source of truth for platform behavior.” `AGENTS.md` § Endpoint-Backed Capability Rule.
>
> “Dashboard code takes the mount from `app/mount.ts` and never writes `/zelavis` or `/api/v1` literally.” `AGENTS.md` § UI Package Rules.

- `packages/zelavis/services/zelavis-auth/src/index.ts:23` registers the Platform Auth menu. Its `dashboard/auth.html:41` renders settings and `:91` derives the mounted API base. Continue to use that service page, with its existing `system.settings.manage` requirement.
- `packages/zelavis/services/zelavis-ui/app/project-pages.ts:175` uses a scoped child config to read Auth providers and OAuth settings. Registration settings use the exact management route from Part 1 so a settings delegate need not hold `project.runtime.manage`.
- `packages/zelavis/services/zelavis-ui/app/auth-pages.ts:26` builds the login form. `app/screens.ts:29`, `app/dashboard-routes.ts:7`, `pages/login/index.html:1` and `behaviors/dashboard.ts:173` wire its route, public shell and bootstrap guard. `app/api.ts:37` provides the Effect request helper.
- `packages/zelavis/services/zelavis-ui/app/host-pages.ts:248` shows Platform Users. `app/project-pages.ts:217` shows Project Users. `app/navigation-menu.ts:35` checks rendered access requirements. `app/projects-pages.ts:61` currently uses the Projects API, which Part 2 filters.
- `packages/zelavis/services/zelavis-ui/scripts/test-embedded-server-views.mjs:1` starts an isolated real Platform and Chromium. `scripts/test-route-parity.mjs:75` handles real owner login. Extend those existing scripts for behavior and route parity at desktop and mobile sizes.

**Pattern to mirror.** `loginScreen` uses `context.run(request(...).pipe(Effect.ensuring(...)), ...)` to finish a submission and restore controls. The Project OAuth settings block uses `context.run` and reloads persisted values. Preserve both patterns.

**Traps.** The Auth plugin setting is a client; it cannot decide whether enrollment is allowed. A new Fuzor page needs both a page entry and route inventory. Treat signup as an auth route in all branches of the shell, including watchers, bootstrap redirects and navigation. A customer-facing Project row must derive actions from actual grants rather than an account's label.

## 2. Design

### Authority, behavior and failures

Platform Auth settings reads and updates `/auth/registration/settings` using the service page's existing authenticated API helper. Project Auth reads and updates `/runtime/projects/:projectId/auth/registration/settings` on the control-plane base. Authorize the displayed control from the corresponding permission. A stopped or older pinned App has an unavailable setting, with a concrete status and no second setting in the dashboard. A scoped settings delegate sees the registration panel even when another provider-administration request is forbidden. Separate the loaders so an unrelated provider or Project runtime config read cannot hide an authorized registration control.

Render a checkbox labelled **Allow public registration** and a Save button. Fetch the current revision before showing an enabled Save. Disable during submit, send `expectedRevision`, re-read on conflict and explain that settings changed. A successful disable leaves existing users signed in. Keep the authorizing endpoint as the only write path and use the mounted client for every request.

`/sign-up` is a native Fuzor auth route. Login loads the public status and shows **Create account** only if password signup is available. First-run setup takes precedence over both login and signup. Direct signup when closed leads to Login with an accessible **Registration is closed** notice and no credential fields. If disable lands after the form opened, a `registration_closed` response clears the password, reloads status and removes the form. Backend errors, rate limits and duplicate results use the server's generic message. Use two password fields with native `autocomplete="new-password"`, validate confirmation locally and clear on completion. Credentials are never stored in search parameters or browser storage. Successful signup uses the issued same-origin cookie and opens Projects. Existing Login continues to use `/auth/authenticate/password`.

Preserve safe return navigation through the existing `resolveReturnTo` helper. If touching it, enforce same-origin mount-local paths through URL resolution and reject cross-origin or protocol-relative values. Signup may use the fixed Projects landing to keep its return URL contract small. Render `Cache-Control: no-store` where auth pages include state. Keep auth controls usable with keyboard and mobile widths.

### Access and customer view

Add a narrow existing-screen **Edit access** drawer. Platform Users and Project Users pass the selected account and its `accessRevision` to the same screen helper. The Platform editor shows a role selector and concrete grants by Project and permission. The App editor uses the fixed `user` role and grants scoped to the current Project. Make existing advanced permissions visible to the owner and preserve fields left untouched when building the replacement payload. Hide owner, service and self edits. The route still enforces all those restrictions. Select a concrete Project from the actor's visible inventory, and use a known permission selection with clear labels. Initially expose `project.view` as **View project and inspect backend**. Part 5 adds a domain grant choice. Stale account revision reloads the row and prompts the operator to reapply their change to current data. If the user's session was revoked by an access edit, use the standard login route.

The `/projects` link is available to authenticated principals. A customer without Projects sees **No projects assigned** and a normal sign-out action. Project-scoped controls use `canAccess` with exact scope and actual required permissions. Do not infer permission from status or a missing config. On direct unauthorized navigation, show the existing API denial. Preserve owner dashboard layout, mobile slide behavior and provider configuration.

### Decisions and needs

Use existing settings and Users surfaces. The signup view belongs to the Fuzor dashboard. Customer onboarding starts in Projects and its commercial steps are separate. No prerequisites from the user.

## 3. Contracts

Use the **NEW** Part 1 `RegistrationStatus { enabled: boolean, providers: readonly string[] }`, `RegistrationSettings { enabled: boolean, revision: number }`, and `SetRegistrationSettingsInput { enabled: boolean, expectedRevision: number }` as consumed schemas. The UI routes are relative to its configured mount. `GET /login` is existing and `GET /sign-up` is **NEW**. Browser signup submits `{ identifier: string, password: string, displayName?: string }` to the existing `POST /auth/sign-up/password`. The form has a client-only confirmation field. It handles `403 registration_closed`, `409 registration_conflict`, `429` with `Retry-After`, `400` validation and `503` unavailable. It does not parse/store the response bearer token. No new HTTP management API belongs to a product package.

Part 2's `SetAccountAccessInput` and `AccountAccessResult` define the Users form. Use `?accountAccess=<encoded-account-id>` as URL drawer state. Load the row from the current account list. Close by removing the parameter, and preserve `q`, `filter` and sidebar state. `PUT /auth/accounts/:accountId/access` and the exact child equivalent are the only save destinations.

## 4. Execution steps

### 1. Prove the starting Fuzor and embedded browser baseline

**Files** `packages/zelavis/services/zelavis-ui/package.json:51–55`, `scripts/test-embedded-server-views.mjs:1–48`, `scripts/test-route-parity.mjs:75`.

**Change** Run the shipped browser check before editing. Select the repo's configured Fuzor source and record provenance. Keep test ports and temporary data isolated. On a real environmental failure, establish its cause and use only the existing browser setup flow.

**Check** From root, `pnpm run ci:ui`. Exit zero. This is the first run of the browser baseline for this plan.

### 2. Add Platform and Project registration controls

**Files** `packages/zelavis/services/zelavis-auth/dashboard/auth.html:41`, `test/auth-settings.test.mjs`; `packages/zelavis/services/zelavis-ui/app/project-pages.ts:175`, `app/api.ts:37`; **NEW** `app/registration-settings.ts`; embedded browser test in step 3.

**Change** Add the Platform Auth settings block and Project native form. Read and write the exact routes from Part 1. Preserve OAuth UI and authorized behavior. Add concise revision/validation decoding in the native UI and a focused test for the bundled HTML's API contract. Add a Playwright owner action to both controls in the existing embedded script. Exercise saved and stale responses. The HTML service page reuses its existing `api` and `el` helpers.

**Imports** `app/registration-settings.ts` uses `import { Effect, Schema } from "effect";`, `import { request, ApiError } from "./api.ts";`, `import { node } from "./dom.ts";`, `import type { ScreenContext } from "./screens.ts";`. `project-pages.ts` adds `import { registrationSettingsCard } from "./registration-settings.ts";` and `import { canAccess } from "./navigation-menu.ts";`. Browser script already imports `assert` and `chromium`.

**Depends on** 1.

**Check** `pnpm --filter @zelavis/ui typecheck`, `pnpm --filter @zelavis/auth test`, then `pnpm run ci:ui` from root. Each exits zero.

### 3. Add the public Platform signup view

**Files** `packages/zelavis/services/zelavis-ui/app/{auth-pages,screens,dashboard-routes,api}.ts`, `behaviors/dashboard.ts:70`, `:126`, `:173`, `src/frontend.ts:51`, **NEW** `pages/sign-up/index.html`, `scripts/test-{route-parity,embedded-server-views}.mjs`.

**Change** Create `signUpScreen` with existing auth-card presentation and typed status loader. Add `isPublicAuthPath` **NEW** to centralize the login, setup and signup decisions currently repeated in the shell behavior. Reuse the `/login` page stub for Fuzor and add the route to the parity inventory. Extend real browser cases for first owner, enabled form, successful customer signup, existing login after disable, direct disabled route and a stale form. Test a nondefault mount using the existing rewrite pattern in `tests/mount-rewrite.test.mjs:45`.

**Imports** `app/auth-pages.ts` adds `link` to `./dom.ts` and uses `registrationStatus` **NEW** from `./api.ts`. `app/screens.ts` adds `signUpScreen` to the `./auth-pages.ts` import. `behaviors/dashboard.ts` imports `isPublicAuthPath` from `../app/dashboard-routes.ts`. `app/api.ts` already imports Effect and Schema. Use existing browser test imports.

**Depends on** 2.

**Check** `pnpm --filter @zelavis/ui typecheck` and `pnpm run ci:ui` from root. Both exit zero.

### 4. Present customer and App access safely

**Files** `packages/zelavis/services/zelavis-ui/app/{host-pages,project-pages,projects-pages,navigation-menu}.ts`, **NEW** `app/account-access-editor.ts`, `tests/navigation.test.mjs`, `scripts/test-embedded-server-views.mjs`.

**Change** Implement the edit drawer using `context.setSearch`, `context.run` and the existing Users routes. Use precise labels for `project.view` and API deny behavior. Keep only allowed project actions in the customer landing. Remove copy that marks now-working customer access as planned. In Playwright, sign in as owner, edit a new customer's grants, sign back in as that customer, and assert only the intended project is listed. Exercise stale revisions, a protected account, blank Projects and a denied server action. Add menu filter assertions for the empty and scoped principals.

**Imports** Editor uses `import { Effect } from "effect";`, `import { array, label, object, request } from "./api.ts";`, `import { button, node } from "./dom.ts";`, `import { card, dataRow } from "./page-kit.ts";`, `import { dropdown } from "./dropdown.ts";`, `import type { ScreenContext } from "./screens.ts";`, and contract type imports from `zelavis/app/identity`. Both Users screens add `import { accountAccessEditor } from "./account-access-editor.ts";`. `projects-pages.ts` imports `canAccess` from `./navigation-menu.ts`. Use existing test imports.

**Depends on** 3.

**Check** `pnpm --filter @zelavis/ui typecheck`, `pnpm --filter @zelavis/ui test`, and `pnpm run ci:ui` from root. All exit zero.

### 5. Document the browser workflows

**Files** `website/src/content/docs/packages/auth.md`, `website/src/content/docs/architecture/access-control.md`, `packages/zelavis/services/zelavis-ui/docs/route-parity.md:9` and a **NEW** changeset for `@zelavis/ui` and `@zelavis/auth`.

**Change** Document exactly where to enable Platform or App registration and edit grants. State that existing accounts can sign in after closing enrollment. Describe the customer landing and separate first-run setup. App public links wait for Part 4.

**Depends on** 4.

**Check** `pnpm run docs:check` from root. Exit zero.

### 6. Self-audit

Reread the full diff. Confirm every route and toggle uses the server contract and that the bundled pages work at both viewports. Rerun section 7 after the final change.

## 5. Tests

- **Owner and signup.** With a new real Platform, visit signup while bootstrap is required and assert Setup. Claim the owner, then confirm Login hides Create account and direct signup shows no form. Enable signup in Auth settings and use the link to create a customer. Assert HttpOnly cookie login and empty Projects. Close registration and verify repeat login works.
- **Stale forms.** Load the signup form in a clean context, close signup from the owner context and submit the old form. Assert a refusal, clear password, hidden form, no account and a useful message. Submit a stale setting revision and confirm reload from server.
- **Project setting.** Start two Apps, enable only one from its scoped Auth screen and read both statuses via the API. No global policy changes. Assert older pinned/stopped App behavior and a delegate without settings authority.
- **Customer access.** Grant one Project and verify customer access after sign-in without server menus or other Projects. Remove it and prove the empty landing. Exercise the conditional editor and exact project ID at desktop and mobile sizes.
- **Asset and mount behavior.** Direct visit, refresh, no mixed mount paths, no unsupported API request or page error, preserved Fuzor frame and no forced full reload on view-only changes.

## 6. Docs and project notes

See step 5. Check private Identity notes at `pnotes/TODO.md:464` only for items this work completes. Leave recovery delivery, email proof, hosting billing and custom RBAC as open work.

## 7. Verification

From root, run `pnpm --filter @zelavis/ui typecheck`, `pnpm --filter @zelavis/ui test`, `pnpm --filter @zelavis/auth test`, `pnpm run ci:ui`, `pnpm run docs:check`, `pnpm run verify`, and `git diff --check`. All exit zero. A development-only render is insufficient browser evidence.

## 8. Instructions to the implementer

Read Status, Progress, overview and earlier execution reports before editing. Recheck cited source and changes since `Verified-at`, including the dirty worktree. Follow `AGENTS.md` and the Fuzor dashboard skill. Mark each step `[~]` before edits and `[x]` after the check passes. On continuation, rerun the last verified check and finish the current step. A recently edited `in progress` plan may belong to another session.

Decide routine details using existing components and record meaningful deviations. Fix required browser and API failures in the current step. Use `[!]` only for a concrete unavailable dependency and continue independent work. Avoid legacy React edits, generated bundles, hardcoded mounts, client-only authorization, password storage and test exemptions. Rerun all gates after the final edit. Update overview status and add a dated execution report with check evidence. Keep publishing and commits separate.

## Execution report

### 2026-11-11

Part 3 complete against `f30953612f` with Parts 1 and 2 and the existing independent worktree changes.

- Proved the starting `pnpm run ci:ui` baseline and 56 focused Identity, account-access, customer-inventory and Platform parity tests before implementation. Builds used the configured local Fuzor 0.5.2 checkout at `ae7ef393a6ea3e4943dd2ee806dee3f1913126ff`, with its existing 116 uncommitted files and recorded digest `bb357a145ec78a498908d46b497c6806b30c49d5de5e1c904cb27f363ad3dc29`.
- Added Platform Auth and exact Project Auth registration controls with conditional revisions, persisted-state recovery after failed saves and concrete stopped/unavailable states. Real disposable Apps prove sibling isolation and a settings-only delegate can save through the exact Project endpoint while its Project inventory is empty.
- Added the native `/sign-up` route, live Login link, password confirmation, generic server errors, rate-limit feedback, password clearing and cookie-based enrollment. First-owner setup retains precedence. Browser checks prove direct closed routes, stale-form refusal, duplicate refusal, existing sessions and login after closing enrollment. Public signup is also qualified at `/ops/panel` on mobile.
- Added URL-backed native access drawers to Platform and Project Users. Conditional saves preserve untouched advanced access, reload on revision conflict and protect owner, service and self identities. Browser checks use the same account ID in the Platform and an App to prove the Project editor saves to the exact child. Desktop/mobile checks cover drawer refresh and Escape, retained query state, role changes, grant preservation, session revocation and assignment/removal of the customer's single visible Project.
- Fixed an existing shell integration gap found during qualification. It fetched `runtime/access` and discarded the answer, while public `runtime/config` supplies configuration. Browser and server-rendered Database navigation now consume the caller's actual access. Scoped checks match the server's concrete-scope rules. Cached menus are cleared on caller changes, and pending menu answers are checked against current access. Customer Project actions and sidebar utilities follow their required permissions. Canonical guidance and the dashboard skill record this source of authority.
- Kept the shared public-auth path classifier in `src/auth-routes.ts`, re-exported from the route inventory for the shell, so the server can set no-store headers using the same classifier. The return-path helper lives in `app/mount.ts` and validates URL resolution within the current mount.
- Unsupported-engine UI coverage uses a simulated missing-settings endpoint (HTTP 404). Running, stopped and sibling behavior use real disposable Apps. HTTP 429 feedback uses an intercepted response, alongside the real duplicate and registration-closed responses.
- Updated public Auth/access documentation, the dashboard README and route qualification notes, the private remaining App-origin TODO, and the `@zelavis/ui` / `@zelavis/auth` changeset.

Final verification exited zero after the last source edit.

- `pnpm run verify`, including all workspace builds, typechecks and tests. The core suite reported 2,867 tests with 2,837 passes and 30 existing environment-gated skips.
- `pnpm --filter @zelavis/ui typecheck`.
- `pnpm --filter @zelavis/ui test`, 92 passing tests.
- `pnpm --filter @zelavis/auth test`, four passing tests.
- `PARITY_SHOTS=/tmp/zelavis-part3-final-shots pnpm run ci:ui`, including the real embedded Platform and nested-mount signup run. Inspected the final desktop/mobile signup, access drawer and customer Projects screenshots.
- `pnpm run docs:check` and `git diff --check`.

Continue with `04-native-app-public-auth.md`. Part 4 owns public login and signup on App site origins.
