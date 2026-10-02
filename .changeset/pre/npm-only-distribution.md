---
"zelavis": minor
"create-zelavis": minor
"@zelavis/marketplace": minor
---

Distribute through npm alone. A release is the published `zelavis` package: `install.sh` and `npm create zelavis` fetch the Node version the release pins from nodejs.org (checked against its published SHA-256) and the exact package from npm, run `npm install` with install scripts off and rebuild only `better-sqlite3`, then run `zelavis install --from-npm`, which assembles the release tree from the package's own installation assets. There are no release archives, GitHub release workflow, APT repository build, GPG keys, signing keys or CI secrets, and `zelavis install --from package` and `--source` are replaced by `--from-npm`.

Host operations are plain manifests in the root-owned operations tree (the Agent refuses a manifest that is not a regular root-owned file that is not group- or world-writable when root ownership is required) and the Agent no longer takes `--operation-trust`. The marketplace allow-list is plain JSON served over https from `https://zelavis.com/allowlist.json`: the signed envelope, trusted keys and mirror sources are gone, while the sequence floor, expiry, https-only, no-redirect and size bounds stay. Release is `npm publish`; `pnpm allowlist publish` writes the list the website serves. The Platform-to-Agent authority key is unchanged. Receipts record entry `script` instead of `archive`, and the complete-uninstall inventory no longer covers an APT source or keyring.
