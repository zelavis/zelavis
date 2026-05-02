# @zelavis/auth

Low-level authentication building blocks for custom backends, internal platforms, CMS systems, and application adapters.

This package is intentionally auth-method agnostic. The core package provides accounts, sessions, repository contracts, and plugin registration, but it does not assume password login, magic links, OAuth, or any specific authentication flow by default.

## Architecture

- Typed domain models for accounts, sessions, and credentials.
- Repository contracts that isolate persistence from auth logic.
- In-memory repositories for development and tests.
- Plugin-oriented credential registration so auth methods stay optional.

## Initial surface

- `createAuth(options)`
- `defineAuthPlugin(plugin)`
- `AccountService`
- `SessionService`
- `AuthenticationService`
- `createInMemoryAuthRepositories()`
- `@zelavis/auth-email-password`
- `@zelavis/auth-username-password`

## Example

```ts
import { createAuth } from "@zelavis/auth";
import { emailPasswordPlugin } from "@zelavis/auth-email-password";

const auth = await createAuth({
  plugins: [
    emailPasswordPlugin({
      verifyPasswordHash: async ({ password, passwordHash }) => password === passwordHash,
    }),
  ],
});

await auth.accounts.create({
  id: "acc_1",
  email: "ada@example.com",
});

await auth.credentials.create({
  id: "cred_1",
  accountId: "acc_1",
  provider: "email-password",
  identifier: "ada@example.com",
  secretHash: "secret",
});

const result = await auth.authentication.authenticate("email-password", {
  identifier: "ada@example.com",
  password: "secret",
});
```

## HTTP Adapters

`@zelavis/auth` exports a server service surface:

- `createAuthServerService(auth)`
- `authService({ authOptions, plugins })`

In the default flow, no auth-specific server plugin is required. `authService()` can be passed directly to `zelavisServer(...)`, and routing is configured centrally via `prefix`, `servicePrefixes`, and `pathOverrides`.

## Error handling

`@zelavis/auth` now uses small internal domain error classes for expected validation and not-found cases. The HTTP service maps those errors centrally so invalid auth input returns `400` and missing auth providers return `404`, without each route needing custom status logic.

Service packages can reuse the shared JSON error helpers exported by `@zelavis/server` when they need the same central mapping pattern.
