---
name: zelavis-release-maintainer
description: Use when preparing or reviewing Zelavis releases, including Changesets, version bumps, publish flow, package README alignment, and release-risk validation across the workspace.
---

# Zelavis Release Maintainer

Use this skill for:

- Changesets work
- versioning and release preparation
- package publish flow
- release-impacting dependency or API changes

## Working rules

- Keep release changes separate from unrelated refactors when possible.
- Prefer explicit release notes over vague changelog language.
- Make sure package README usage still matches the shipped API.
- Call out breaking changes clearly and early.

## Release checklist

1. Confirm which packages are actually affected.
2. Add or review the relevant changeset.
3. Verify public API and docs still match.
4. When the distribution footprint changes, verify the staged
   `share/uninstall.sh` inventory, isolated destructive-path test, and public
   complete-uninstall documentation cover every newly owned host resource.
5. Run the release validation commands before publishing.
   When an official service changes, publish that service first, run
   `pnpm allowlist update`, and only then build and publish the Platform.
   `pnpm allowlist check` refuses defaults that differ from the qualified checkout
   versions. A fresh runtime composes its catalogue from the shipped snapshot;
   a website refresh applies on its next start and cannot repair the initial
   catalogue of a release that shipped an outdated default.
6. Keep alpha vs stable intent explicit.
   Manual npm browser verification requires an interactive terminal; the release
   wrapper uses direct recursive pnpm publishing after Changesets versioning.
7. A release is `npm publish` and nothing else: no signing keys, secrets, GitHub
   Actions/Releases, archives or APT repository (AGENTS.md "Distribution Trust
   Model"). Do not add them without the owner asking. After publishing, install the
   new version on a real host and run `zelavis doctor`; refresh
   `pnpm allowlist update` / `pnpm allowlist publish` and deploy `website/` when
   services changed.
8. Installed servers update themselves from the dashboard (`zelavis update`), picking the
   newest version on their channel from npm, so a published version is what they will
   install. A release that cannot start is rolled back by the updater, but never publish
   one on purpose; the first release that carries the updater still has to be installed
   by running the installer, because older versions have no updater.
9. Every future release must be installable through dashboard **Update now**,
   including major runtime, protocol and installation-layout changes. Requiring
   terminal commands or an installer rerun for a normal update is a product defect.
   Qualify the ordinary update action from the previously installed release before
   publishing; fresh-install and synthetic-version checks alone do not prove this.
   The current pre-handover manual conversion is a known gap to eliminate, not a
   precedent. Preserve data, Project locks, access URLs and rollback guarantees
   through the existing trusted updater authority, without permanent legacy paths.

## Useful commands

```bash
pnpm changeset
pnpm release:status
pnpm release:version
pnpm release:version:alpha
pnpm release:publish:alpha
pnpm release:publish:latest
pnpm release:check
```

`pnpm release:check` includes `release:qualify:update` against the actual previous
npm release in disposable Linux/systemd. Docker is required for this release gate,
not for ordinary workspace verification. Before publication only candidate
acquisition is substituted. After publication qualify the ordinary authenticated
API/systemd action with real npm acquisition using `ZELAVIS_QUALIFY_UPDATE=npm`
and `ZELAVIS_PROVISIONING_FROM_NPM=<previous exact version>`. Preserve continuous
HTTP traffic, Project process custody, preview URLs, locks and data; prove App
selection in both directions across real distinct published engine versions.
A plugin inside each running engine must report its executing Zelavis version;
descriptor fields alone do not qualify a version switch.

Qualify managed app integration recipe updates under continuous traffic. Preserve
process identities, preview ports, app files, database and runtime configuration;
prove actual SDK menu, REST/setup endpoint, discovery and disk-page activation,
removal, permissions, commit rollback/recovery and Agent adoption without app
provisioning or lifecycle commands. A menu metadata change alone is insufficient. Native
App upgrades/version switches must retain the full Platform/App engine handover.

For bound managed Apps, open the previous release's private runtime before the
parent update. Prove adoption and engine convergence under traffic with unchanged
app and host process identities, recipe lock, files and ownership. Exercise native
Auth/Database/Storage/Workloads APIs, usage-based native navigation, private state
retention across integration handover/restart, and Project cleanup. Opening the
bound runtime only after the parent update does not qualify existing instances.
