# Security Policy

Thank you for helping keep Zelavis and its community safe.

## Reporting a Vulnerability

Please do **not** open public GitHub issues for security vulnerabilities.

Use GitHub's private vulnerability reporting flow for this repository when
available:

- <https://github.com/zelavis/zelavis/security/advisories/new>

If you cannot use that flow, contact the repository owner privately through
GitHub and avoid disclosing exploit details in public issues, pull requests, or
discussions.

When reporting an issue, please include:

- affected package or area
- impact and attack scenario
- reproduction steps or proof of concept
- suggested mitigation, if you have one

We will do our best to acknowledge reports promptly, investigate them fairly,
and coordinate a fix before public disclosure when that is appropriate.

## Supported Scope

Security reports are especially useful for:

- `packages/zelavis/services/zelavis-server`
- `packages/zelavis/services/zelavis-fabric`
- `packages/zelavis/services/zelavis-app/src/db`
- `packages/zelavis/services/zelavis-app/src/auth`
- `packages/zelavis`
- `packages/zelavis/services/zelavis-ui`
- official plugins under `plugins/*`
- CI, release, and dependency-supply-chain concerns in this repository

## Local Security Checks

Zelavis tracks dependency security with pnpm audit and GitHub Dependabot.

Run the default security audit:

```bash
pnpm run audit:security
```

Run the broader full audit:

```bash
pnpm run audit:security:full
```

## Disclosure and Fixes

When a vulnerability is confirmed, maintainers may:

- prepare a private fix first
- release patched packages before broad disclosure
- publish advisory notes or changelog context after a fix is available

## Tracked Advisory Exceptions

When the ecosystem reports a vulnerability without a usable upgrade path yet,
Zelavis may temporarily document and track that exception here so routine
audits can remain actionable.
