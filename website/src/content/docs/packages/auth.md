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
  --project PROJECT_ID \
  --expires-days 365 \
  --token "$OWNER_SESSION_TOKEN"
```

The token is returned once. Store it in the client's credential vault. Rotate
it with `auth service-accounts rotate ACCOUNT_ID` and revoke the entire machine
identity with `auth service-accounts revoke ACCOUNT_ID`.

The `--project` shortcut adds the scoped grants used by a Project operator:
`project.view`, `project.runtime.manage`, `project.settings.manage`, and
`project.users.manage`. Omit it when the client should only have the explicit
Platform permissions passed with `--permission`.

Service tokens authenticate as principal type `service`, not as a user, so
audit and policy code can distinguish software from people.
