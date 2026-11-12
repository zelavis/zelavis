---
title: Auth
---

Zelavis Auth serves two separate identity boundaries:

- **Platform identity** is for owners, DevOps users, CI, agents, and software
  such as Fluxgent that operates the Zelavis Platform.
- **Project identity** belongs to an App's users. Accounts, credentials,
  sessions, and provider credentials are stored in that Project's database and
  are not shared with the Platform or another Project.

Use a Platform service account for software. Owner browser sessions are for
people and should not be copied into applications.

## Public registration

The Platform and every App start with registration closed. The Platform also
requires its first owner to finish bootstrap before anyone can sign up. You can
enable signup for one runtime without changing any other runtime or restarting
it. In an embedded runtime, `subsystems.auth.registration` supplies an initial
setting. A saved setting takes precedence.

An enabled runtime accepts password signup and first-time OAuth account
creation. Existing users can sign in and link identities while signup is closed.
Signup issues a regular session and gives new Platform accounts the `customer`
role and App accounts the `user` role. These accounts have no implicit grants.
Email ownership verification for password accounts remains planned.

In the dashboard, open **Auth** in the Platform navigation, select
**Allow public registration**, and save. To change one App, open its
**Backend → Auth** page and save that Project's registration setting.
A settings delegate can also visit the Project's Auth URL directly.
Each control reads the saved revision and reloads it after a conflicting edit.
A stopped App displays its unavailable setting until its runtime starts.

When password signup is available, **Login → Create account** opens the
Platform signup form. A completed signup opens Projects with a normal browser
session. A customer begins with **No projects assigned**. Closing registration
keeps existing sessions active and existing accounts can still sign in.
A direct closed signup URL returns to Login with a registration-closed notice.
First-run visits continue to the owner setup wizard until bootstrap completes.

Use `client.auth.registrationStatus()` or `zelavis auth registration-status --json`
to read availability. Operators can read the current revision with
`client.auth.admin.registrationSettings()` or `zelavis auth registration-settings --json`.
Pass that revision as `expectedRevision` when updating:

```bash
zelavis auth set-registration-settings --data '{"enabled":true,"expectedRevision":0}' --json
zelavis projects set-registration-settings PROJECT --data '{"enabled":true,"expectedRevision":0}' --json
```

The Project command targets the named running App through the Platform. Read
its revision with `zelavis projects registration-settings PROJECT --json` or
`client.projects.registrationSettings(projectId)`. Use
`client.projects.setRegistrationSettings(projectId, input)` to update it.
A stale revision returns HTTP 409. Platform settings require
`system.settings.manage`. Project settings require `project.settings.manage`
for the named Project.

## Native App login and signup

Open `/zelavis/login` on the native App's verified site hostname or Edge
preview. **Backend → Auth** links to a running App's published preview when its
engine supports these pages. Login links to `/zelavis/sign-up` while password
registration is open. A closed signup page returns HTTP 404 and the server
refuses submissions from previously loaded forms. Login and signup send the
visitor to the App's site root. Signed-in visitors can revisit the login page
to sign out.

Use HTTPS for public password traffic. HTTP previews are suitable for local
testing. App cookies are HttpOnly, scoped to the App mount, and Secure on
HTTPS. The cookie name and bearer audience are unique to each Project, even
when preview ports share a hostname. Users with older App browser cookies
sign in again on the public origin.

Point the SDK at the App's site origin and use the existing Auth methods.
The CLI `--url` includes the App mount.

```ts
import { createZelavisClient } from "zelavis/sdk";

const app = createZelavisClient({ baseUrl: "https://app.example.com" });
const status = await app.auth.registrationStatus();
```

```bash
zelavis auth registration-status --url https://app.example.com/zelavis --json
zelavis auth session --url https://app.example.com/zelavis --token "$APP_SESSION_TOKEN" --json
```

`signUpWithPassword` and `signInWithPassword` return the App's session token.
Send it as `Authorization: Bearer …` for SDK or CLI self-session reads,
rotation and logout. Browser requests on the App origin can use its cookie.
Account administration and registration settings remain on the authenticated
Platform Project routes. Managed third-party apps serve their own login pages.

## Human account access

Platform administrators with `system.users.manage` in system scope can replace
another human account's access. App administrators require
`project.users.manage` for that exact App. The caller must hold every existing
and requested permission at its scope. A top-level Platform permission requires
the same top-level authority in the caller.

Platform roles are `customer`, `operator` and `reseller`. App accounts use
`user`. Role labels carry only the authority an endpoint explicitly requires.
Setting an operator or reseller label also requires that label in the caller,
or the caller's global wildcard authority. Owner, service, pending and the
caller's own account are protected from this operation.

Read `accessRevision` from `client.auth.admin.accounts(accountId)` or
`zelavis auth accounts ACCOUNT --json`. Accounts with no prior edit start at
revision zero. Pass it to the conditional replacement.

```ts
await client.auth.admin.setAccountAccess(accountId, {
  expectedRevision: 0,
  role: "customer",
  permissions: [],
  grants: [
    { permission: "project.view", scope: { type: "project", projectId: "my-app" } },
  ],
});
```

```bash
zelavis auth set-account-access ACCOUNT --data '{"expectedRevision":0,"role":"customer","permissions":[],"grants":[{"permission":"project.view","scope":{"type":"project","projectId":"my-app"}}]}' --json
zelavis projects set-account-access PROJECT ACCOUNT --data '{"expectedRevision":0,"role":"user","permissions":[],"grants":[]}' --json
```

The equivalent HTTP operations are `PUT /auth/accounts/:accountId/access`
and `PUT /runtime/projects/:projectId/auth/accounts/:accountId/access`,
relative to the configured API base. The exact Project SDK method is
`client.projects.setAccountAccess(projectId, accountId, input)`.
The named App must be running. Its account edit accepts an empty
`permissions` array and concrete grants scoped to that App.

Access input is a strict object with at most 100 permissions and grants
combined. Wildcards and route-parameter scopes are refused. A change increments
`accessRevision` and invalidates every previously issued account session in
one write. The user signs in again to use the new access. A matching no-op
preserves the revision and sessions. Stale input returns
`account_access_conflict` (409), invalid input returns `invalid_account_access`
(400), and refused delegation returns `account_access_forbidden` (403).
New Platform grants must name existing Projects or installed services.

Use **Server → Access → Users → Edit access** for a Platform human account.
For App accounts, use that Project's **Users → Edit access**. The drawer URL
retains the selected account, filters and sidebar position across a refresh.
Choose a Platform role and a visible Project, then add **View project and
inspect backend** to assign that Project's view grant. An App editor keeps
the User role and fixes grant scope to the current Project.
Existing advanced permissions and grants stay visible and are retained
unless explicitly removed. A stale save reloads current access for review.
Changing access signs that account out of its existing sessions.

The security event records the actor ID, target ID and committed revision.
If its append fails after the access write, HTTP 503 returns
`account_access_audit_failed` with that `accessRevision`. Read the account
before deciding the next edit.

Signed-in customers initially receive an empty `client.projects.list()`.
An exact `project.view` grant adds that Project to their inventory.
Project view includes workload visibility, database inspection and reads,
and storage reads. Each mutation still requires its own permission.
Global inventory requires `projects.list`, a top-level `project.view`, or
the corresponding wildcard authority. Scoped inventory accepts at most
100 distinct Project IDs and omits deleted Projects.

Grant-bearing account creation, credential administration and service-token
operations enforce the same delegation rule. General account creation and
imports refuse identity metadata such as `principalType`, `serviceAccount`
and `tenantId`. Imports retain their verification and password-import contract.

## SDK

The official client exposes a typed `auth` surface:

```ts
import { createZelavisClient } from "zelavis/sdk";

const app = createZelavisClient({ baseUrl: "http://127.0.0.1:3000" });

// Use the App runtime's own API address. Signup requires its registration policy to be open.

const signedUp = await app.auth.signUpWithPassword({
  identifier: "person@example.com",
  password: "a long unique password",
  displayName: "Person",
});

const signedIn = await app.auth.signInWithPassword({
  identifier: "person@example.com",
  password: "a long unique password",
});

await app.auth.getSession();
await app.auth.refreshSession();
await app.auth.signOut();
```

OAuth sign-in uses `auth.signInWithOAuth(provider)`, which returns the
authorization URL for the provider-neutral Authorization Code ceremony.
`auth.linkIdentity(provider)` starts the explicit account-linking variant.

## Importing accounts

`POST /auth/accounts/import` (account management), `client.auth.admin.importAccounts({ accounts, dryRun?, hashConfig? })`
and `zelavis auth import-accounts --data JSON` create accounts from another system's export. Each entry is
`{ email?, username?, displayName?, verified?, metadata?, passwordHash?, passwordSalt? }` and needs an email or a
username.

- A password carries over whenever its hash can be verified here:
  - PBKDF2-SHA256 in Zelavis's format (`pbkdf2-sha256$iterations$salt$hash`) or Django's (`pbkdf2_sha256$…`), with
    at least 100,000 iterations, converted without loss;
  - bcrypt (`$2a$`, `$2b$`, `$2y$`: Supabase's `auth.users`, Laravel, Devise), at cost 4 to 14, and Django's
    `bcrypt_sha256$…`;
  - scrypt as Django stores it (`scrypt$n$salt$r$p$hash`), up to 64 MiB;
  - Firebase Authentication's modified scrypt: each account's `passwordHash` and `passwordSalt` as `firebase
    auth:export` writes them, and the project's parameters once for the file as
    `hashConfig: { algorithm: "firebase-scrypt", signerKey, saltSeparator, rounds, memCost }`, copied from the
    Firebase console (Authentication → Password hash parameters). An unknown `hashConfig` is refused.

  bcrypt and scrypt are verified in plain JavaScript over Web Crypto's PBKDF2 and AES-CTR, so nothing native is
  needed on any runtime, and the work yields to the scheduler as it runs. Those hashes are kept as they came and
  replaced by Zelavis's own PBKDF2 hash the first time their owner signs in; the answer lists the accounts in
  `rehashOnSignIn`. Until then an imported hash is as sensitive as it was in its source (a Firebase hash carries the
  source project's signer key). Any other hash cannot be verified here, so the account gets a password credential
  without one and its owner sets a password through recovery; those accounts are listed in `needsReset`, and an
  unverifiable hash is never stored where sign-in would trust it.
- An account whose email or username is already held is skipped, so a repeated import creates only what is
  missing. With any problem in the file, or with `dryRun`, nothing is written and the answer lists the problems by
  row. Imported accounts carry `metadata["zelavis.import"]` saying when and whether their password carried over
(`carried`, `rehash-on-sign-in` or `needs-reset`).

## Project provider settings

Every Zelavis App Project ships password sign-in and can enable registration.
Its Auth dashboard page can configure GitHub, Google, or another OpenID Connect issuer.
The client ID, redirect URI, enabled state, and write-only client secret are
Project-owned settings. Changing one Project never changes Platform login or
another Project.

The same capability is available to automation through
`client.auth.admin.oauthConnections()`, `configureOAuth()`, and
`removeOAuth()`. Provider settings require the Project-scoped
`project.settings.manage` grant.

## Platform service accounts

Create a revocable machine identity from **Access → Users**, through
`client.auth.admin.createServiceAccount()`, or from the CLI:

```bash
zelavis auth service-accounts create \
  --name Fluxgent \
  --permission projects.list \
  --permission projects.create \
  --expires-days 365 \
  --token "$OWNER_SESSION_TOKEN"
```

The token is returned once. Store it in the client's credential vault. Rotate
it with `auth service-accounts rotate ACCOUNT_ID` and revoke the entire machine
identity with `auth service-accounts revoke ACCOUNT_ID`.

`--permission` names Platform-wide authority. For a Project-scoped client, use
`--project PROJECT_ID` with explicit, repeatable `--project-permission` flags:

```bash
zelavis auth service-accounts create --name "App reader" \
  --project PROJECT_ID --project-permission project.data.read \
  --token "$OWNER_SESSION_TOKEN"
```

Naming a Project adds no implicit operator grants. Use `project.data.write` for
record writes and `project.data.define` for schema/collection/index changes;
neither is needed by a reader. The CLI requires Project identity and scoped
permissions together. SDK/HTTP clients express the same grants explicitly in
`grants: [{ permission, scope: { type: 'project', projectId } }]`.

Service tokens authenticate as principal type `service`, not as a user, so
audit and policy code can distinguish software from people.
