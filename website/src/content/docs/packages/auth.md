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

## SDK

The official client exposes a typed `auth` surface:

```ts
import { createZelavisClient } from "zelavis/sdk";

const app = createZelavisClient({ baseUrl: "https://app.example.com" });

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

Every Zelavis App Project ships password registration and sign-in. Its Auth
dashboard page can configure GitHub, Google, or another OpenID Connect issuer.
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
