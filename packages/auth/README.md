# @zelavis/auth

Low-level authentication building blocks for custom backends, internal platforms, CMS systems, and application adapters.

This package is intentionally auth-method agnostic. The core package provides accounts, sessions, repository contracts, and service registration, but it does not assume password login, magic links, OAuth, or any specific authentication flow by default.

## Architecture

- Typed domain models for accounts, sessions, and credentials.
- Repository contracts that isolate persistence from auth logic.
- In-memory repositories for development and tests.
- Service-oriented credential registration so auth methods stay optional.

## Initial surface

- `createAuth(options)`
- child auth provider services declared with `defineService(...)`
- `AccountService`
- `SessionService`
- `AuthenticationService`
- `createInMemoryAuthRepositories()`
- `@zelavis/auth-email-password`
- `@zelavis/auth-username-password`

## Example

```ts
import { createAuth } from "@zelavis/auth";
import { emailPasswordService } from "@zelavis/auth-email-password";

const auth = await createAuth({
  services: [
    emailPasswordService({
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

- `defineAuthService(auth)`
- `authService({ authOptions, services })`

The main service-definition entrypoint lives in
[packages/auth/src/auth-service.ts](/Users/ivanjeremicx/Projects/zelavis/packages/auth/src/auth-service.ts),
and uses the same `defineService(...)` builder as installable, static, and provider services.

In the default flow, no auth-specific server extension hook is required. `authService()` can be passed directly to `zelavisServer(...)`, and routing is configured centrally via `prefix`, `servicePrefixes`, and `pathOverrides`.

## Error handling

`@zelavis/auth` now uses small internal domain error classes for expected validation and not-found cases. The HTTP service maps those errors centrally so invalid auth input returns `400` and missing auth providers return `404`, without each route needing custom status logic.

Service packages can reuse the shared JSON error helpers exported by `@zelavis/server` when they need the same central mapping pattern.
