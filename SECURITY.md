# Security

Zelavis tracks dependency security with pnpm audit and GitHub Dependabot.

Run the default security audit:

```bash
pnpm run audit:security
```

Run the full audit, including intentionally tracked ignored advisories:

```bash
pnpm run audit:security:full
```

## Tracked Advisory Exceptions

### GHSA-rmmr-r34h-pfm5

`@tanstack/history` is currently reported by npm as:

- severity: critical
- title: Malware in `@tanstack/history`
- path: `packages/ui > @tanstack/react-router > @tanstack/history`
- patched versions: none published

The package is pulled in through the TanStack Router/Start dashboard stack. As of the last audit, the latest published versions still resolve to the affected package and npm reports no patched version.

Zelavis keeps this advisory ignored in the default `audit:security` script and recorded in `pnpm.auditConfig.ignoreCves` so routine audits can continue to catch actionable issues. This exception should be removed as soon as TanStack or npm publishes a clean upgrade path.
