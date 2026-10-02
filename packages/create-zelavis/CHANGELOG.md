# create-zelavis

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
