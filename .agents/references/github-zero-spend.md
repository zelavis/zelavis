# GitHub zero-spend operations

The canonical policy is in `AGENTS.md`. Standard Ubuntu Actions execution is
free while this repository is public; storage and paid runners require separate
attention. Billing settings are live account settings, not something a commit
can enforce. Check them again if ownership, visibility, or billing changes.

## Budgets and the Stop usage checkbox

Open https://github.com/organizations/zelavis/settings/billing/budgets
(organization Settings → Billing and licensing → Budgets and alerts).

For an existing Actions budget, open its row's menu → Edit. The budget amount
must be $0 and **Stop usage when budget limit is reached** must be checked.
For a missing budget, choose New budget → Product-level budget → Actions,
scope it to the whole organization, enter $0, enable Stop usage, then save.
Alerts by themselves do not block spending. Keep equivalent $0 hard-stop
budgets for Packages, Codespaces and Git LFS. Personal-account repositories
have their own billing owner: check https://github.com/settings/billing/budgets
separately if applicable. A $0 metered budget does not cancel paid subscriptions.

On 2026-10-06 the organization's Actions, Packages, Codespaces and Git LFS rows
were inspected and each showed $0 budget, $0 spent, and Stop usage Yes. This is
a dated observation, not a guarantee that settings remain unchanged.
The edit page also reported that a payment method was missing and required one
before adjusting budgets. Leave the already-correct budget in place; do not add
a payment method merely to edit it.

## Artifacts and obsolete distribution archives

An Actions artifact is a file uploaded by a workflow, separate from source code,
an npm release, the local `distribution/` source folder, and an installed App's
frozen runtime artifacts. The retired Distribution artifacts workflow uploaded
four packaged builds: `zelavis-linux-x64`, `zelavis-linux-arm64`,
`zelavis-darwin-x64` and `zelavis-darwin-arm64`. The current npm installer does
not use these archives. The four archives from run 35503058277 were deleted on
2026-10-06, freeing 3,194,257,614 bytes. Three small historical SARIF security
report artifacts were preserved.

To inspect future storage:

```bash
gh api repos/zelavis/zelavis/actions/artifacts --paginate \
  --jq '.artifacts[] | {id,name,size_in_bytes,workflow_run}'
```

In the UI: repository → Actions → select the originating workflow run →
Artifacts at the bottom of its summary → trash icon beside the obsolete file.
Check the name and originating run before deletion. With an inspected ID:

```bash
gh api --method DELETE repos/zelavis/zelavis/actions/artifacts/ARTIFACT_ID
```

Deletion is permanent. It reduces retained storage but does not erase accrued
usage from the billing period. Never delete source directories, npm releases,
installed engine artifacts or Project data as part of Actions storage cleanup.

## Dependency caches

The former `cache: pnpm` setup saved dependency downloads under keys containing
the OS, architecture and lockfile hash. Pull-request refs and dependency updates
created separate caches; this was ordinary caching behavior, not damaged data.
Caches can be rebuilt from the lockfile and registry. CI now omits `cache` and
sets `package-manager-cache: false` on every `actions/setup-node` step. Do not
add a substitute cache action. The next install may take longer after cleanup.

UI: https://github.com/zelavis/zelavis/actions/caches
(repository → Actions → Management → Caches). Delete obsolete entries there,
or clear all rebuildable dependency caches through the CLI:

```bash
gh cache list --repo zelavis/zelavis --limit 100
gh cache delete --all --succeed-on-no-caches --repo zelavis/zelavis
gh api repos/zelavis/zelavis/actions/caches --jq .total_count
gh api repos/zelavis/zelavis/actions/cache/usage
```

Aggregate usage and billing displays may lag behind the empty cache listing.
Do not increase paid cache limits. On 2026-10-06 GitHub's cache-limit API returned
HTTP 402 requiring a valid payment method; no payment method was added. Clearing
caches and disabling cache creation work independently of that settings API.
Older branches can still contain cache-enabled workflows: review them before
rerunning an old workflow or restoring retired distribution automation.

## Shared cleanup schedule during development

`pnpm dev` starts an Effect-scoped maintenance task after the development
processes start. It checks immediately and every hour, but performs cleanup
only when seven days have elapsed since the shared successful-cleanup timestamp.
That timestamp is a non-secret repository Actions variable named
`ZELAVIS_ACTIONS_STORAGE_LAST_CLEANUP`, stored on GitHub, not in a local file or
an Actions cache/artifact. Find it under repository Settings → Secrets and
variables → Actions → Variables. It is written and read back only after all
selected deletions are verified absent, even if no items were eligible.
A missing timestamp makes the first run due. Invalid or future values require
inspection rather than silently disabling the schedule.

Every maintainer uses their own `gh auth login` session. The authenticated user
needs repository Write access. Fine-grained tokens need **Actions: read and
write** for deletions and **Variables: read and write** for the shared timestamp;
an Actions-only token cannot update the marker. No Admin or billing permissions
are needed. Authentication is not shared or stored in the repository.

Automatic maintenance skips CI, checkout origins other than the canonical
`zelavis/zelavis` GitHub repository, and explicit opt-out:

```bash
ZELAVIS_GITHUB_MAINTENANCE=0 pnpm dev
```

GitHub failures produce a warning and retry on the next hourly check without
blocking development. API subprocesses have a 20-second timeout and are aborted
when the owning Effect fiber is interrupted on dev-server shutdown. Development
must be running for checks to happen; there is no OS timer or hosted workflow.

Manual commands use the same canonical repository and policy:

```bash
pnpm github:storage:check # read-only inventory and cleanup plan
pnpm github:storage:clean # cleanup only if the shared timestamp is due
```

The deletion policy is intentionally narrow:

- Dependency caches must have the recognized `node-cache-<OS>-<arch>-pnpm-<hash>`
  key and must not have been accessed in the last 24 hours.
- Archives must have one of the four retired distribution names, be at least
  24 hours old, and belong to a completed run of `.github/workflows/distribution.yml`
  in this repository.
- SARIF reports, unknown names, caches with unfamiliar keys, and recent items
  are preserved and shown in the read-only inventory.

The shared variable is a scheduling hint, not an atomic lock. Machines re-read
it before deletion, but simultaneous due runs can still overlap. A deletion
404 is accepted only with subsequent absence verification. Concurrent first-run
variable creation can fall back to updating the variable. Failed cleanup does
not advance the successful-cleanup timestamp. The $0 budget, not this schedule,
remains the spending protection.

## Local qualification

Use Node 24 and the pnpm version in the root `packageManager` field:

```bash
pnpm install --frozen-lockfile
pnpm ci:runtime
pnpm distribution:test
pnpm docs:check
pnpm website:typecheck
pnpm --filter @zelavis/ui exec playwright install chromium
pnpm ci:ui:local
```

macOS tests run directly on the Mac. Docker Desktop runs Linux containers; on
Apple Silicon, native Linux containers are ARM64 and x64 requires emulation.
The existing WordPress provisioning container script uses privileged Debian
with systemd: run it in an isolated disposable Linux environment on the VPS,
after the required builds. Never run provisioning directly on the production
host. Self-hosted runners remain optional and must not expose the everyday Mac
or production VPS to untrusted public pull-request jobs.

References:

- https://docs.github.com/en/billing/how-tos/set-up-budgets
- https://docs.github.com/en/billing/concepts/product-billing/github-actions
- https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching
- https://docs.github.com/en/actions/reference/security/secure-use
