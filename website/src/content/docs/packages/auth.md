---
title: "@zelavis/auth"
---
`@zelavis/auth` provides low-level authentication building blocks for custom backends and internal platforms.

## Current role

This package is intentionally auth-method agnostic.

It currently provides:

- account models and services
- session models and services
- credential models and services
- repository contracts
- service registration

## Design rule

The core auth package should not assume one fixed authentication method.

Provider-style auth methods stay optional through services.

Authorization requirements are not owned only by `@zelavis/auth`. The base
principal, grant, and route-access vocabulary lives in `@zelavis/server` so
every service endpoint can declare access requirements regardless of whether
the principal came from a dashboard session, API key, service token, SSO,
Hosting Provider customer login, or another auth method.

`@zelavis/auth` should resolve and manage identities and sessions. The server
contract should enforce route requirements once a principal exists.

## Current examples

Official method services currently include:

- `@zelavis/auth-email-password`
- `@zelavis/auth-username-password`

## Related docs

- [zelavis](./zelavis.md)
- [@zelavis/server](./server.md)
- [Access Control](../architecture/access-control.md)
- [Service Authoring](../guides/service-authoring.md)
