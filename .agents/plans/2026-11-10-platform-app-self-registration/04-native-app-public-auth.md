# Public login and signup on native App origins

Job: Let an App's users register and sign in on that App's public site or preview independently of Platform accounts.
Date: 2026-11-10
Status: complete
Verified-at: f30953612f
Part: 4 of 5. Read 00-overview.md first.
To start:    Execute the plan in .agents/plans/2026-11-10-platform-app-self-registration/04-native-app-public-auth.md. Start with its section 8.
To continue: Continue the plan in .agents/plans/2026-11-10-platform-app-self-registration/04-native-app-public-auth.md. Start with its section 8.

## Progress

- [x] 1. Give App sessions distinct site credentials.
- [x] 2. Attach the bundled App auth frontend.
- [x] 3. Route the public App auth surface through existing ingress.
- [x] 4. Qualify App signup and login in Chromium and document it.
- [x] 5. Self-audit.

## 0. Summary and finish line

The Project dashboard toggle configures its child runtime. Visitors instead use the native App's public site. Add a small auth frontend and a narrowly permitted public path to that child on verified domains and supported previews. Both SDK and browser use the native auth operations from Part 1.

- **In scope** — public password login, conditional signup, App session self-operations, distinct App session audience and exact public ingress rules.
- **Out of scope** — serving an operator dashboard on an App domain, publishing child administrative APIs or creating a built-in account UI for managed third-party software. App OAuth enrollment stays governed by Part 1 through its existing configured flows. These password pages do not add OAuth buttons or public callback routes.
- **Done means** — a native App can be enabled and visited on its public origin, a new account and cookie belong to that App, and no Platform credential or child management route is exposed. Both installed release and project preview paths use the same boundary.
- **Supplement** — checked supplement with focused-test cwd correction. Part 1 provides auth policy/operations, Part 3 provides form and UI patterns. Part 5 will provide default customer domain onboarding; this part verifies the already supported host-binding interface.
- **Sources read** — `AGENTS.md:345`, `:807`, `:1701`, `:1887`, `:2202`, `:2436`, core platform and dashboard skills and the source below.

## 1. Context packet

**Glossary.** Site origin means a verified hostname or an Edge preview URL. The management Gateway proxies signed requests from the Platform origin and strips child cookies. A native App's site ingress relays anonymous visitor requests without a Platform principal. App session audience means the exact Project owning the stored session. A frontend factory is an existing host-selected composition input.

> “Preserve visitor Host, site cookies and redirects across host transport while stripping Platform cookies and authority headers.” `AGENTS.md` § Runtime Independence Rule.
>
> “A Project's face is the static `kind: "frontend"` package installed in that folder, mounted at its root.” `AGENTS.md` § Platform And App Service Boundary.

- `packages/zelavis/src/platform/public-domain-forwarder.ts:117` resolves a verified binding, waits for `ingressReady` and reads a Project. `:141` is shared by verified domains and previews. `:167` currently rejects every `/zelavis` path, `:171` can select a running frontend, `:184` strips Platform authority and `:243` preserves non-Platform cookies.
- `packages/zelavis/src/index.ts:7617` forwards previews after placement checks. `:7790` guards Platform root routes before dispatch so bound customer domains never serve the Platform's login. Keep that guard on every other path.
- `packages/zelavis/src/platform/project-gateway.ts:267` drops child cookies on the authenticated management proxy. `:546` signs a scoped envelope for runtime traffic. That path is unsuitable for App public sessions.
- `packages/zelavis/src/app/identity/core/session-authenticator.ts:75` defaults to `zelavis_session`; `services/session-service.ts:73` mints `zvs_` bearer tokens. `identity-service.ts:107` decides same-origin cookie creation. Tokens are opaque and checked against the owning repository digest.
- `packages/zelavis/src/platform/frontend-host.ts:18` defines `ZelavisPlatformFrontendContext` with mounted root and in-process fetch. `packages/zelavis/services/zelavis-ui/src/frontend.ts:14` resolves a trusted bundled frontend with `loadPluginPackage`. `src/dashboard-service.ts:7` registers shell behavior. `packages/zelavis/src/adapters/_node-project-engine.ts:101` opens a native App or managed integration engine from its exact selected release.
- `packages/zelavis/test/platform-public-domain-forwarding.test.mjs:121` tests that control-plane paths stay private. `:300` proves visitor Host and site cookies survive. `packages/zelavis/test/edge-previews.test.mjs:8` exercises real loopback previews.

**Pattern to mirror.** Use the existing frontend factory and `zelavis.frontend.configure` inside `loadPluginPackage` with host-selected scope. Use the existing App site forwarder after a strict path/method classification. The current verified-host guard remains before any possible Platform route match.

**Traps.** A port is not a cookie boundary. One preview must not receive a sibling or Platform cookie. A running server frontend is not the App's Identity runtime. Sharing a public proxy wildcard would publish administrative methods. A failed Project lookup on a verified App hostname must answer on that hostname with a bounded error rather than fall through to Platform login. Never infer authority from the raw Host or forwarding headers.

## 2. Design

### Sessions

For a native App with Project ID, derive a fixed `audience` from the first 24 lowercase hexadecimal characters of SHA-256 over the UTF-8 Project ID. Compute it once during identity composition. Add **NEW** `projectSessionAudience` in `packages/zelavis/src/app/identity/core/project-session-audience.ts`, exported internally for ingress and App composition. Mint App tokens as `zvs_app_<audience>_<43-character-base64url-random>` with the same 32 random bytes and persisted token digest. Use `zelavis_app_<audience>` as the default App session cookie name. Preserve existing Platform names. Treat the audience prefix only as a routing filter; the child's SessionService still checks the digest, expiry and epoch. The cookie has the App's configured mount Path, no Domain, HttpOnly, SameSite Lax and Secure on HTTPS. The same cookie name is used by issuance, authentication, rotation and deletion. Configure App password calls through the existing same-origin header helper. Preserve bearer-only headless operation when cookies are explicitly disabled.

For public App auth paths, strip all Platform cookies, sibling App cookies and inbound signed authority headers. Forward only the selected App's expected cookie and its audience-shaped bearer, with no actor synthesized by the parent. On those responses forward only that App cookie. On other public frontend paths keep ordinary site cookies and filter Zelavis auth cookies according to the existing protection policy. Avoid relaying bearer values or logging them. A parent supplied authorization header is never synthesized. Existing sessions with the old default cookie need a fresh sign-in on the public surface when adopting this feature.

### Public UI and ingress

Use a dedicated auth-only frontend factory from `@zelavis/ui` loaded from the exact native App release. It uses a minimal auth card with the common form behavior from Part 3, no operator shell and no dependency on the Project's chosen site frontend. Use the public `ZelavisPlatformFrontendFactory` contract and ordinary package loader. The App adapter selects it through the existing `frontend` option, separately from the Project's site frontend mounted at `/`. Headless consumers can keep using the same native API. Managed integration engines do not attach this public frontend.

Public auth routes use a fixed, audited allowlist. Match literal method and canonical path, reject ambiguous encoded separators, repeated slashes, traversal, host casing ambiguity and unrelated admin URLs. Determine the selected native App from verified binding or preview placement, then use that Project's actual native runtime target, bypassing its separate running server frontend for these paths. Preserve its existing `ingressReady` admission/fencing and trusted Host/proto rewrite. If a bound domain is stopped or unavailable, respond with the site error. The guard handles the allowlisted path directly or returns the existing 404 for other `/zelavis/*` paths, so an allowed path never falls into the Platform dispatcher. For a preview use exactly the same classifier and header filter. Unsupported placement returns the existing public-site availability error.

The built-in Project form is a password client. Its signup view reads `RegistrationStatus` server-side with the frontend context's in-process fetch, serves `404` without a form when disabled, and sends a same-origin JSON request on submit. Login remains reachable when registration is closed. On success navigate to the App site `/` with an App cookie. This is the App's own user journey and does not send a SaaS user into an operator dashboard. Preserve branding copy generic enough for the App owner. An existing selected static/server frontend can link to these routes or use the same public password SDK methods directly.

### Bounds, failures and decisions

Keep body limits at 8192 bytes before forwarding auth writes and at the existing dispatcher limit for other public traffic. Use the existing ingress deadlines and scoped cleanup. Allow only the fixed small frontend assets. Apply `no-store` for pages and auth responses and use same-origin CSP and frame restrictions. Ensure disabled status and policy races are decided by Identity. Auth forwarding failures return 503 or the existing bounded gateway/site error. No cross-runtime credential or implicit fallback if the child lacks this feature. Needs from the user are none.

## 3. Contracts

Public App routes are relative to the known native App mount. The packaged default is `/zelavis`. Append the configured API prefix/version only for the existing API paths.

| Method and path | Source | Response |
| --- | --- | --- |
| **NEW** `GET /login` | Auth-only frontend | Login form and signup link only when enabled |
| **NEW** `GET /sign-up` | Auth-only frontend | Form if password signup enabled, otherwise 404 |
| **NEW** `GET /auth-assets/identity.js`, `GET /auth-assets/identity.css` | Fixed authored assets | Exact asset only, correct MIME and cache policy |
| `GET /auth/registration` | Native Identity from Part 1 | `RegistrationStatus` |
| `POST /auth/sign-up/password`, `POST /auth/authenticate/password` | Existing Identity routes | Existing safe session result and matching origin cookie |
| `GET /auth/session`, `DELETE /auth/session`, `POST /auth/session/rotate` | Existing Identity routes at `packages/zelavis/src/app/identity/identity-service.ts:720`, `:870`, `:826` | Existing self-session contracts, authenticated by the App |

**NEW** `type ProjectPublicAuthRoute = "page" | "asset" | "api"` and `classifyProjectPublicAuthRequest(method: string, pathname: string, rootPath: string, apiBasePath: string): ProjectPublicAuthRoute | undefined` in `packages/zelavis/src/platform/project-public-auth.ts`. It has a closed table of exact matches. `projectSessionAudience(projectId: string): Promise<string>` returns the fixed audience. Existing typed `client.auth.registrationStatus`, `.signUpWithPassword`, `.signInWithPassword`, `.getSession`, `.signOut` and `.refreshSession` and CLI equivalents target the App public origin. There is no new transport operation for the frontend assets. HTML is outside the parity operation inventory.

## 4. Execution steps

### 1. Give App sessions distinct site credentials

**Files** **NEW** `packages/zelavis/src/app/identity/core/project-session-audience.ts`; `packages/zelavis/src/app/identity/core/{create-identity,session-authenticator}.ts`, `services/session-service.ts:73`, `identity-service.ts:107`; `packages/zelavis/src/app/app-service.ts:116`; `packages/zelavis/test/{identity-registration,identity-atomicity}.test.mjs`.

**Change** Derive audience from the host-provided exact Project ID, then thread the default cookie name and token issuer through the existing Project identity composition. Preserve the Platform's token and cookie contract. Use the same name in all Auth responses. Unit tests sign in with both roles, try cross-runtime credentials and prove cookie name, path, SameSite and flags. Keep normal App/Platform token expiry and revocation semantics.

**Imports** Audience helper uses `import { Effect } from "effect";` and `import { present, integration } from "../../../core/runtime/effect-boundary.js";`. App composition adds `import { projectSessionAudience } from "./identity/core/project-session-audience.js";`. Identity modules reuse existing Effect and crypto boundary imports. Tests use the existing registration fixture and strict assert.

**Check** From root, `pnpm --filter zelavis run build` then `pnpm --filter zelavis exec node --test test/{identity-registration,identity-atomicity,core-password-auth}.test.mjs`. Exit zero.

### 2. Attach the bundled App auth frontend

**Files** `packages/zelavis/services/zelavis-ui/{package.json,tsconfig.plugin.json}`, **NEW** `src/identity-frontend.ts`, **NEW** `src/identity-frontend-service.ts`, **NEW** `app/identity-site.ts`; `scripts/build.mjs`; `packages/zelavis/src/cli/bundled-frontend.ts:16`, `packages/zelavis/src/adapters/_node-project-engine.ts:101`, `packages/zelavis/src/adapters/_local-runtime.ts:1255`, `packages/zelavis/package.json:181`; focused browser script in step 4.

**Change** Export `zelavisUiIdentityFrontend` from the bundled UI `./identity-frontend` entry. Its factory loads the manifest with scope `system` and a separate registration module that configures only auth rendering and fixed assets. Let that shell serve the literal auth asset routes from an exact map loaded at composition; do not resolve request paths on disk. Reuse the existing frontend mount and in-process status fetch. Scope the bundle output to its authored JS/CSS assets and preserve the normal site frontend at `/`. Reuse `provideHostPackagesTo` and the verified bundled directory selection in the Node Project engine. Load the App's own engine package, with no ambient package fallback in production. Run the baseline browser suite before changing bundle outputs if it has not already run for this part.

**Imports** Factory mirrors `packages/zelavis/services/zelavis-ui/src/frontend.ts:1–9` for fs/path/url, Effect, `loadPluginPackage`, manifest and frontend types. Registration imports `import { Effect } from "effect";`, `import { zelavis } from "zelavis/sdk";`, `import type { ZelavisPlatformFrontendContext } from "zelavis";`. Browser entry imports `Effect`, `request`, `node` and shared password field/form helpers from its UI modules. Engine adds `import { resolveBundledServiceDirectory } from "./_local-runtime.js";`, `import { provideHostPackagesTo } from "./_service-resolution.js";` and uses the new `resolveBundledIdentityFrontend` helper from `../cli/bundled-frontend.js`.

**Depends on** 1.

**Check** `pnpm --filter @zelavis/ui typecheck`, `pnpm --filter @zelavis/ui build` and `pnpm --filter zelavis run build` from root. Then run `pnpm --filter zelavis exec node --test test/runtime-project-host.test.mjs`. All exit zero and the packaged bundle exposes only the named App frontend routes.

### 3. Route the public App auth surface through existing ingress

**Files** **NEW** `packages/zelavis/src/platform/project-public-auth.ts`; `packages/zelavis/src/platform/public-domain-forwarder.ts:117`, `:141`, `:283`; `packages/zelavis/src/index.ts:7617`, `:7790`; `packages/zelavis/test/{platform-public-domain-forwarding,edge-previews,platform-project-gateway}.test.mjs`.

**Change** Share the exact route classifier for bound domains and previews. Match the host-selected native App and use its placement target. Enforce the protected cookie and bearer policy in the forwarder and preserve the existing management Gateway. Use the closed table before any general `/zelavis/*` handling. Preserve safe redirect handling and site header rules. Pass the selected App origin with normalized Host/proto to support same-origin validation and cookie issuance. Assert no route or header leaks on stopped, unavailable or third-party Projects. Test a selected server frontend keeps normal site requests and never sees public auth traffic.

**Imports** Classifier uses `import { projectSessionAudience } from "../app/identity/core/project-session-audience.js";` for its separate header helpers. Forwarder adds `import { classifyProjectPublicAuthRequest } from "./project-public-auth.js";` and uses existing Effect, Gateway header and public fetch imports. `src/index.ts` uses the updated public forwarder and guard imports it already has. Tests reuse their existing Node listener and memory binding fixture imports.

**Depends on** 2.

**Check** From root, rebuild and run `pnpm --filter zelavis exec node --test test/{platform-public-domain-forwarding,edge-previews,platform-project-gateway,runtime-project-host}.test.mjs` with local listeners permitted. All exit zero.

### 4. Qualify App signup and login in Chromium and document it

**Files** `packages/zelavis/services/zelavis-ui/scripts/test-embedded-server-views.mjs:1`, `app/project-pages.ts:175`; `website/src/content/docs/{packages/app.md,packages/auth.md,architecture/access-control.md,architecture/edge.md}` and **NEW** changeset.

**Change** In the existing embedded browser harness, create two native Apps and publish one existing preview. Toggle its setting from the operator dashboard, follow the App public link, sign up and sign out, disable and sign back in. Confirm only the correct cookie namespace and child account. Exercise verified binding with the HTTP fixture and configured custom mount with the frontend tests. Add Project Auth links only from its public preview or verified domain metadata, using `siteUrl` from `app/projects-pages.ts:35` when a verified public origin is not present. No private runtime URL link. Document App-specific SDK and CLI base URLs, required HTTPS for public password use, exact public routes and distinct admin routes.

**Imports** Reuse `chromium`, Node `assert` and temporary server fixtures already in the browser script. Project Auth reuses its existing `siteUrl`, `node` and `link` imports.

**Depends on** 3.

**Check** `pnpm run ci:ui` and `pnpm run docs:check` from root. Exit zero. Verify 1440px and mobile browser runs.

### 5. Self-audit

Review every public method/path and header at both the parent and child. Re-run the protocol, runtime handover, browser and docs suites after the last edit.

## 5. Tests

- **Boundary.** Arrange two Apps, a running separate server frontend, a managed Project, a verified domain and a stopped Project. Request public auth and unrelated `/zelavis` paths. Assert only exact allowed routes for a running native App, existing public site behavior, and no Platform login fallback. Reject encoded/ambiguous paths and nonmatching verbs.
- **Session audience.** Sign up on App A with the same identifier as Platform and App B. Assert cookies and bearer tokens work only on A and logout clears A's cookie. Verify Platform and B authorization never reaches A, and cookie-origin rules remain enforced. Check scripts see the issued bearer and can call self-session over the public origin.
- **Browser.** Open App A login and signup on preview. Confirm hidden link/404 when disabled. Enable and sign up using the App form, visit App root, sign out, then log in with registration closed. B remains closed. Repeat with same-IP preview ports and desktop/mobile viewports. Confirm no operator workspace UI on the App origin.
- **Handover and failure.** Start from a live App, exercise the current exact-engine handover, retain its policy and session and check boundary again. Verify denied routes and stopped/old child handling remain closed. Run the actual loopback tests, which the sandbox otherwise prevents.

## 6. Docs and project notes

See step 4. Update the private identity/Edge open work only when a planned limitation changes. Describe actual App public ingress and keep the managed third-party software's login separate.

## 7. Verification

From root, run `pnpm --filter @zelavis/ui build`, `pnpm --filter zelavis run build`, `pnpm --filter zelavis exec node --test test/{identity-registration,identity-atomicity,platform-public-domain-forwarding,edge-previews,platform-project-gateway,runtime-project-host}.test.mjs`, `pnpm run verify`, `pnpm run ci:ui`, `pnpm run docs:check`, and `git diff --check`. Each exits zero.

## 8. Instructions to the implementer

Read Status, Progress, overview, prior execution reports and the core platform and dashboard skills. Compare verified source and uncommitted changes before editing. Mark `[~]` before edits and `[x]` after the check passes. On continuation confirm the last completed check and preserve other work. A recently edited `in progress` plan may have an active session.

Decide routine choices against the existing contracts. Resolve failures in their step. Mark `[!]` only for a concrete unavailable dependency and continue independent work. Keep the Site forwarder and management Gateway separate, preserve scoped writer admission, avoid hardcoded dashboard mounts, path wildcards for App Auth, generated output edits, silent catches and Promise orchestration in Platform code. Rerun every gate after the final edit. Update the overview and a dated execution report with evidence. Commits, deployment and publishing are separate work.

## Execution report

### 2026-11-11

- Ran the Part 3 production-browser baseline before editing. The worktree already contained Parts 1–3 and independent changes. The local Fuzor build used checkout `ae7ef393a6ea3e4943dd2ee806dee3f1913126ff` at 0.5.2 with its existing 116 uncommitted files and digest `bb357a145ec78a498908d46b497c6806b30c49d5de5e1c904cb27f363ad3dc29`.
- Native App Identity derives the cookie and token audience from the exact Project ID. The persisted token digest, expiry and epoch still govern authentication. Focused tests cover Platform and sibling credentials, cookie-disabled clients, rotation, logout and HTTPS flags.
- The selected Node App engine loads the bundled frontend from its own release. Four literal routes mount as a runtime subsystem and App config advertises their availability. The existing `dist` package inventory carries the entry and two assets. The actual tarball test checks their presence and exact names.
- Verified bindings and both preview listener paths use the same public method and path table. The forwarder sends only the selected App's credentials on auth requests and uses the existing Project placement and handover. The worker handles those requests on a reserved internal POST path. This lets older engines refuse the request without resolving it as a native Identity operation or a static site page. The older-engine check uses a fixture. The running App and persistent Platform host handover checks use real worker processes.
- The Project Auth page links to the Edge preview when the child advertises public auth. The current Project inventory supplies preview metadata. Verified hostname links depend on the inventory in Part 5. A verified hostname fixture already exercises the App flow with an HTTPS origin and loopback transport.
- The production browser fixture covers signup and closed-registration login at 1440 and 390 pixels, stale forms, site-root navigation, sign-out, independent Platform accounts, same-host sibling previews and CLI session access. Public docs, the private TODO and the changeset describe the shipped workflow.

#### Final verification

- `pnpm --filter zelavis run build`, `pnpm --filter @zelavis/ui typecheck` and `pnpm --filter @zelavis/ui build` exited zero.
- The section 7 focused Node suites plus password, Platform foundation, Platform handover and tarball tests passed 135 tests.
- `pnpm run verify` exited zero. The core suite reported 2,843 passes and 30 existing environment-gated skips out of 2,873 tests.
- `PARITY_SHOTS=/tmp/zelavis-part4-final-shots pnpm run ci:ui` exited zero. Inspected the desktop and mobile App login and signup screenshots. The existing nested Platform mount run also passed.
- `pnpm run docs:check` and `git diff --check` exited zero.

Continue with `05-project-domain-management.md`.
