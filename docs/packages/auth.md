# @zelavis/auth

`@zelavis/auth` provides low-level authentication building blocks for custom backends and internal platforms.

## Current role

This package is intentionally auth-method agnostic.

It currently provides:

- account models and services
- session models and services
- credential models and services
- repository contracts
- plugin registration

## Design rule

The core auth package should not assume one fixed authentication method.

Provider-style auth methods stay optional through plugins.

## Current examples

Official method plugins currently include:

- `@zelavis/auth-email-password`
- `@zelavis/auth-username-password`

## Related docs

- [zelavis](./zelavis.md)
- [@zelavis/server](./server.md)
- [Service and Plugin Authoring](../guides/service-and-plugin-authoring.md)
