# create-zelavis

## 0.1.0-alpha.8

### Patch Changes

- Share Node Platform and App engine factories, and use Effect scopes to close HTTP before stores during shutdown and failed startup. Add shared Effect admission and handover primitives and a Node supervisor with streaming ingress, exclusive writer transfer, generation checks and rollback, exercised against both actual runtime compositions.

  Add immutable recipe snapshots, a scoped kernel-locked journal with flushed release/generation checkpoints, and a Gateway broker that preserves replay protection and queued authorization across worker replacement. Reserve a fresh generation for every update attempt, including aborted drains, and bound the complete readiness probe.

  Run native Apps behind a persistent host and allow qualified running recipe upgrades through the existing HTTP, SDK, CLI and dashboard action. Persist an unfinished Project update, freeze the candidate separately, and acknowledge the Platform recipe lock before admission resumes. Failed lock commits roll back; reconciliation settles lost replies from proved host selection. Preserve deletion precedence and re-key surviving Gateway hosts over the Agent pipe.

  Seal full engine artifacts including their private Node and dependency-link graph, execute installed App locks through the exact release catalog, and retain qualified engine versions during Platform updates. Stage releases through the same script-disabled npm transport used by installations.

  Run the main Platform behind the same persistent host. Dashboard updates prepare an immutable release, drain accepted requests, transfer exclusive store ownership, probe adoption of running Projects, and acknowledge the root-owned receipt, current link and public version descriptor before resuming traffic. Preview listeners share admission and remain bound during transfer and rollback. User installations use the same handover.

  Enable the separately supervised Project Agent for every system installation; remove the optional Agent flag. Adopt WordPress daemon handles by exact execution identity and put Linux Unix sockets in shared installation data so the Platform and Agent can use them across separate private temporary directories. Preserve Project placement custody across engine replacement. Unexpected engine exit wakes the host for supervised restart.

  Explicit native App recipe upgrades select the latest qualified installed engine. New Apps use that same default, even on an older parent; parent upgrades and rollbacks preserve existing App engine pins. Public older-version selection controls remain planned.

  Breaking installation transition: installations without the persistent host and versioned runtime inventory need one full local installer run, which restarts the old process. The live installer refuses unsupported handover protocols; there is no legacy execution shim.

  Persist status refreshes under the same Project lifecycle permit as upgrades so a stale read cannot overwrite a recipe lock, update intent or deletion tombstone. Fleet views remain read-only for Fabric scheduling. Keep ordinary Platform startup ready while desired-running Projects reconcile asynchronously; require adoption proof only for engine handover.

## 0.1.0-alpha.7

### Minor Changes

- 587d43e: Update a server from its own dashboard. The Platform checks npm for a newer version on its channel (at start and every six hours), a banner offers **Update now** on every page, and Settings has an Updates card; `zelavis update status|check|apply [--wait]`, `client.updates` and `GET /runtime/updates`, `POST /runtime/updates/check` and `/apply` do the same (`system.updates.view` / `system.updates.manage`). The unprivileged Platform only drops a request; a root-owned `zelavis-update.path` unit starts `zelavis update --run`, which looks up the newest version itself (never taking one from the request), refuses anything not newer, runs the installer embedded in the installed release, waits for the new release to answer, and rolls back to the previous release if it does not. The installer sets the two units up for the default system instance, `zelavis doctor` reports whether updates are armed (`update-watch`), and complete uninstall removes the units and the `<data>/update` folder. User-mode installs, named instances and macOS still update by running the installer again.

## 0.1.0-alpha.6

### Minor Changes

- 5027eb8: A server install ends with a URL you can open. The default instance of a systemd installation now listens on all interfaces at port 3000 instead of loopback, and the installer prints `http://<server-ip>:3000/zelavis` with the first-owner token, so there is no SSH tunnel to set up. The token still decides who may claim the owner account, the address is plain HTTP until the setup wizard's hostname step adds HTTPS, and there is no loopback-only server mode. User-mode installs and named instances stay on `127.0.0.1` unless given `--public`. Re-running the installer applies the new bind.

## 0.1.0-alpha.5

### Patch Changes

- e2f9e9c: Fix the Platform service crash-looping on a real Linux host. The Edge ownership lock lives in the root-owned installation prefix, and SQLite writes a database header (needing a journal file in that directory) the first time anyone locks an empty file, which the unprivileged service user cannot do, so every start failed with a misleading "already reserved". The installer now initializes the lock file as root and the service only takes the lock. Re-running the installer repairs an existing install. Ownership errors now name the real cause instead of always saying the lock is reserved.

## 0.1.0-alpha.4

### Patch Changes

- 02a8ba1: Remove the last native dependency. The local System Store now uses Node's built-in `node:sqlite` instead of `better-sqlite3`, which ships no prebuilt binaries and so needed a compiler (`make`, a C++ toolchain) on the server and failed to install on a plain Debian/Ubuntu host. The bootstrap no longer rebuilds anything, and the launcher silences Node's experimental-SQLite warning. The installed tree is plain JavaScript on the private Node.

## 0.1.0-alpha.3

### Minor Changes

- f22ba11: Install named Linux/systemd instances with isolated data, config, accounts,
  tokens, ports and independently selected private-Node releases. All entries
  continue using one TypeScript installation plan and canonical release templates.
  Only default may own host Edge, enforced by its persistent record and kernel
  reservation; secondary instances run with Edge off. Doctor and complete removal
  select an instance locally. Removing one preserves shared releases, commands,
  unit templates and package state until the last instance is removed. Debian
  packages own only an incoming payload; persistent releases and current links
  are installer-owned, so package upgrades retain versions selected by other instances.
  Receipts now record the selected port and Edge authority; old pre-release
  receipts are refused without migration. Zero-downtime updates remain planned.

  Exclude handed-down allow-list cache files and their exact atomic-write temporary
  names before collecting remote Project snapshots, avoiding a rename race during
  Agent dispatch while continuing to refuse other local Project data.
  Register graceful CLI shutdown before HTTP readiness so an immediate service
  stop closes the selected instance's data ownership cleanly.
- 57ba50a: Distribute through npm alone. A release is the published `zelavis` package: `install.sh` and `npm create zelavis` fetch the Node version the release pins from nodejs.org (checked against its published SHA-256) and the exact package from npm, run `npm install` with install scripts off and rebuild only `better-sqlite3`, then run `zelavis install --from-npm`, which assembles the release tree from the package's own installation assets. There are no release archives, GitHub release workflow, APT repository build, GPG keys, signing keys or CI secrets, and `zelavis install --from package` and `--source` are replaced by `--from-npm`.

  Host operations are plain manifests in the root-owned operations tree (the Agent refuses a manifest that is not a regular root-owned file that is not group- or world-writable when root ownership is required) and the Agent no longer takes `--operation-trust`. The marketplace allow-list is plain JSON served over https from `https://zelavis.com/allowlist.json`: the signed envelope, trusted keys and mirror sources are gone, while the sequence floor, expiry, https-only, no-redirect and size bounds stay. Release is `npm publish`; `pnpm allowlist publish` writes the list the website serves. The Platform-to-Agent authority key is unchanged. Receipts record entry `script` instead of `archive`, and the complete-uninstall inventory no longer covers an APT source or keyring.
- 1c5ecbc: Replace folder scaffolding with a machine installation through the shared Zelavis installer. Create selects the exact Platform version and uses a private Node in system or user mode. System elevation acquires a fresh root-owned tree rather than executing package-cache files as root.

  Add `zelavis install --from-npm <prepared-tree>` and `--user`, preserve the versioned release layout, and include user data/configuration/token/receipt in complete uninstall. The launcher never falls back to host Node. Singleton locking, doctor and named instances remain planned.

### Patch Changes

- 9a51a3c: Add host-local installation ownership guards and read-only `zelavis doctor`. Install/removal are serialized by a kernel-released installer lock; Node/Bun Platform startup and maintenance share one data guard. Current receipts record source, entry, mode, instance, version and paths, and package/create installs use the same receipt-owned removal inventory. Foreign layouts, live data owners and occupied port 3000 are refused; force only permits command replacement. Old pre-release receipt shapes are refused without migration.

  Create forwards the invoking PATH only for conflict inspection while privileged bootstrap commands retain a fixed trusted PATH. Doctor reports installation, service, port and Agent host-feature state without changing files or taking locks. System repair/upgrade can stop and restart a matching owned Platform; zero-downtime updates and named instances remain planned.
- 9f203ba: Share one authored bootstrap with the public machine installer. It fetches the private Node pinned by the release from nodejs.org and the exact `zelavis` version from npm, and forwards installation flags to the common host-local installer.

## 0.1.0-alpha.2

### Patch Changes

- Services resolve `zelavis` and `effect` from the Platform and must carry the rest; update and uninstall report when a restart is advisable; unreferenced installed packages are pruned; `npm create zelavis` scaffolds a Platform with a services folder.
