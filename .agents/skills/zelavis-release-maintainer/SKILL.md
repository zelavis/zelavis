---
name: zelavis-release-maintainer
description: Use whenever the owner asks to release, publish or cut a version of Zelavis ("release a new alpha", "publish a new version", "cut a stable release"), and when preparing or reviewing a release: Changesets, versioning, publishing services and the Platform, the allow-list, release qualification and the update gate. Holds the full step-by-step release runbook.
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

## Release runbook

A release is a sequence with a human in it: the owner types npm's login and approves
2FA in their browser, and approves every outward step (publish, push, website deploy).
Everything else is the agent's. Say how long a step takes before starting it, run
long steps in the background, and keep the machine awake (lid open) while they run.

1. **Start from `dev`.** It must hold every change for the release, committed; another
   agent's uncommitted files in the main checkout are never staged. Each change carries
   a changeset (`.changeset/*.md`) saying what users get, in their words.
2. **Use the release worktree** `../zelavis-release`, detached at `dev`
   (`git worktree add --detach ../zelavis-release dev` the first time, then
   `git checkout --detach dev` in it). Releases never touch the main checkout.
3. **Version** in the worktree: `pnpm release:version:alpha` (or `release:version` for a
   stable release; prerelease mode must be exited first). Read the CHANGELOG it writes,
   commit `chore(release): version packages (alpha.N)`. If the build then changes
   generated files (the dashboard bundle), commit them as their own release commit.
4. **Allow-list, when a service changed:** `pnpm allowlist update` in the worktree, then
   commit the snapshot. A service version npm does not have yet is listed with the digest
   of its local pack (packing is deterministic and npm's digest is the digest of the
   uploaded tarball), so nothing is published first and nothing waits for npm.
5. **Qualify:** `pnpm release:check` in the worktree (about 15 minutes measured on
   2026-10-14: workspace checks, then Docker qualification: the update gate from the actual
   previous npm release, then the worker installation). Nothing else may build in the
   worktree meanwhile: two builds there delete each other's `dist`. It must end green and print
   `Qualified <sha>`. A red run is fixed on `dev` (commit, push when the owner agrees),
   the worktree is re-versioned from `dev`, and qualification starts again. Never publish
   on red, and never count a lucky rerun as qualification: find why it failed.
6. **Publish (owner).** Hand the owner, in a terminal tab:
   `npm login --auth-type=web`, then
   `ZELAVIS_RELEASE_QUALIFIED=<sha> pnpm release:publish:alpha` in the worktree. One run
   publishes services and Platform together: it packs each pending package with `pnpm pack`
   (rewriting `workspace:` ranges), refuses before publishing anything if a service tarball's
   digest is not the one the allow-list names, and publishes with `npm publish`, `zelavis`
   first; npm prints "Authenticate your account at …" for each, which the owner approves. It
   does not wait for npm to list what it published. A 404 from npm means "not logged in" or "this
   token may not publish": log in again with `--auth-type=web`. `pnpm publish` must not be
   used: it answers that 404 without starting npm's login.
7. **Confirm** `npm view zelavis dist-tags` names the new version (npm lists it within
   minutes) and that its `dist.integrity` matches the packed tarball the script reported.
8. **Merge back:** in the main checkout, `git merge --ff-only <release commit>` (the worktree
   is `dev` plus the release commits), then push `dev` when the owner agrees. `dev` must
   hold exactly what was published.
9. **Website, when services changed:** `pnpm allowlist publish` writes
   `website/public/allowlist.json`; deploy `website/` with
   `wrangler pages deploy dist --project-name zelavis-website --branch main` only after the
   owner approves that deploy.
10. **Record** the release in `pnotes/TODO.md` (what shipped, what the gate proved, anything
    learnt), commit and push it separately.
11. **After publishing:** installed servers offer the version in **Update now**. Optionally
    qualify the published path with real npm acquisition (`ZELAVIS_QUALIFY_UPDATE=npm`,
    below). Tell the owner what to do on their server, if anything.

## Release rules

- Confirm which packages are actually affected; keep release changes separate from
  unrelated refactors; prefer explicit release notes over vague changelog language.
- Make sure package README usage still matches the shipped API, and call out breaking
  changes clearly and early.
- When the distribution footprint changes, verify the staged `share/uninstall.sh`
  inventory, isolated destructive-path test, and public complete-uninstall documentation
  cover every newly owned host resource.
- `pnpm allowlist check` (part of `release:check`) refuses defaults that differ from the
  qualified checkout versions. A fresh runtime composes its catalogue from the shipped
  snapshot; a website refresh applies on its next start and cannot repair the initial
  catalogue of a release that shipped an outdated default.
- A release is `npm publish` and nothing else: no signing keys, secrets, GitHub
  Actions/Releases, archives or APT repository (AGENTS.md "Distribution Trust Model").
  Do not add them without the owner asking.
- Installed servers update themselves from the dashboard (`zelavis update`), picking the
  newest version on their channel from npm, so a published version is what they will
  install. A release that cannot start is rolled back by the updater, but never publish
  one on purpose; the first release that carries the updater still has to be installed
  by running the installer, because older versions have no updater.
- Every future release must be installable through dashboard **Update now**, including
  major runtime, protocol and installation-layout changes. Requiring terminal commands or
  an installer rerun for a normal update is a product defect. Qualify the ordinary update
  action from the previously installed release before publishing; fresh-install and
  synthetic-version checks alone do not prove this. The current pre-handover manual
  conversion is a known gap to eliminate, not a precedent. Preserve data, Project locks,
  access URLs and rollback guarantees through the existing trusted updater authority,
  without permanent legacy paths.

## Useful commands

```bash
pnpm changeset
pnpm release:status
pnpm release:version
pnpm release:version:alpha
pnpm release:check
pnpm release:publish:alpha
pnpm release:publish:latest
pnpm allowlist update
pnpm allowlist publish
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

Production ingress changes must qualify domain-free HTTP and dashboard assets through real Traefik, a private fresh-install management listener, conflict refusal, and continuous public HTTP during Platform engine rollback/reselection. Update now must activate and enable the proxy through existing root update authority without restarting it or Project processes.
