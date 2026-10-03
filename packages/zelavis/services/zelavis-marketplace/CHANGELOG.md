# @zelavis/marketplace

## 1.1.0-alpha.14

### Patch Changes

- Updated dependencies
  - zelavis@2.0.0-alpha.14

## 1.1.0-alpha.13

### Patch Changes

- Updated dependencies
  - zelavis@2.0.0-alpha.13

## 1.1.0-alpha.12

### Patch Changes

- Updated dependencies [bbe74e4]
- Updated dependencies
- Updated dependencies
  - zelavis@2.0.0-alpha.12

## 1.1.0-alpha.11

### Patch Changes

- Updated dependencies [4105a52]
  - zelavis@2.0.0-alpha.11

## 1.1.0-alpha.10

### Patch Changes

- Updated dependencies [587d43e]
  - zelavis@2.0.0-alpha.10

## 1.1.0-alpha.9

### Patch Changes

- Updated dependencies [5027eb8]
  - zelavis@2.0.0-alpha.9

## 1.1.0-alpha.8

### Patch Changes

- Updated dependencies [e2f9e9c]
  - zelavis@2.0.0-alpha.8

## 1.1.0-alpha.7

### Patch Changes

- Updated dependencies [02a8ba1]
  - zelavis@2.0.0-alpha.7

## 1.1.0-alpha.6

### Minor Changes

- 57ba50a: Distribute through npm alone. A release is the published `zelavis` package: `install.sh` and `npm create zelavis` fetch the Node version the release pins from nodejs.org (checked against its published SHA-256) and the exact package from npm, run `npm install` with install scripts off and rebuild only `better-sqlite3`, then run `zelavis install --from-npm`, which assembles the release tree from the package's own installation assets. There are no release archives, GitHub release workflow, APT repository build, GPG keys, signing keys or CI secrets, and `zelavis install --from package` and `--source` are replaced by `--from-npm`.
  
  Host operations are plain manifests in the root-owned operations tree (the Agent refuses a manifest that is not a regular root-owned file that is not group- or world-writable when root ownership is required) and the Agent no longer takes `--operation-trust`. The marketplace allow-list is plain JSON served over https from `https://zelavis.com/allowlist.json`: the signed envelope, trusted keys and mirror sources are gone, while the sequence floor, expiry, https-only, no-redirect and size bounds stay. Release is `npm publish`; `pnpm allowlist publish` writes the list the website serves. The Platform-to-Agent authority key is unchanged. Receipts record entry `script` instead of `archive`, and the complete-uninstall inventory no longer covers an APT source or keyring.

### Patch Changes

- Updated dependencies [f22ba11]
- Updated dependencies [9a51a3c]
- Updated dependencies [15e0ed3]
- Updated dependencies [57ba50a]
- Updated dependencies [1c5ecbc]
  - zelavis@2.0.0-alpha.6

## 1.1.0-alpha.5

### Patch Changes

- Updated dependencies
  - zelavis@2.0.0-alpha.5

## 1.1.0-alpha.4

### Patch Changes

- Updated dependencies
  - zelavis@2.0.0-alpha.4

## 1.1.0-alpha.3

### Minor Changes

- 28bde9d: Collapse the service kind taxonomy to `app`, `frontend`, and `plugin`, and
  enforce it at manifest validation.
  
  `frontend` was missing from `ZelavisServiceKind` despite being the kind the
  Platform branches on most — it has its own load path, a `zelavis.frontend`
  manifest block, and Gateway routing. Meanwhile `core`, `web-app`, `website`,
  `dashboard-extension`, `provider`, and `template` were declared, documented,
  and never read by anything.
  
  `core` is removed rather than kept: it described who shipped a service rather
  than what it is, which `scope` (`system` versus `extension`) already carries
  and which the dashboard now enforces. Every service the Platform composes is a
  `plugin`. A provider is discovered by its capability (`provider:auth`), never
  by a kind.
  
  An unrecognised kind is now refused. It previously loaded fine and produced a
  service that silently never participated in anything, which is also how the
  union drifted out of date in the first place.

### Patch Changes

- 6a8c8c2: Automatically detect and resolve package.json manifests across all services and plugins, eliminate manifest.ts files, and extract @zelavis/app as an official kind: "app" service.
- Updated dependencies [df8fcf2]
- Updated dependencies [d2b22c4]
- Updated dependencies [49177f0]
- Updated dependencies [71c1c4f]
- Updated dependencies [a59cfad]
- Updated dependencies [cd26722]
- Updated dependencies [61cde5e]
- Updated dependencies [3bf1481]
- Updated dependencies [313b7a2]
- Updated dependencies [48dbb58]
- Updated dependencies [448e097]
- Updated dependencies [c56a596]
- Updated dependencies [344368e]
- Updated dependencies [ac8daa0]
- Updated dependencies [493e2b5]
- Updated dependencies [874e983]
- Updated dependencies [7a32736]
- Updated dependencies [7bf02e0]
- Updated dependencies [3663b43]
- Updated dependencies [9957059]
- Updated dependencies [de5f3fe]
- Updated dependencies [f68f2da]
- Updated dependencies [3dbc353]
- Updated dependencies [48dbb58]
- Updated dependencies [2ffffbb]
- Updated dependencies [88c4f0e]
- Updated dependencies [48dbb58]
- Updated dependencies [694ae12]
- Updated dependencies [48dbb58]
- Updated dependencies [7e5cc15]
- Updated dependencies [62b2e91]
- Updated dependencies [ffb15fc]
- Updated dependencies [2833e08]
- Updated dependencies [503b6c0]
- Updated dependencies [48dbb58]
- Updated dependencies [349549b]
- Updated dependencies [0e6fdc5]
- Updated dependencies [0e6fdc5]
- Updated dependencies [ebab0bb]
- Updated dependencies [6aac906]
- Updated dependencies [c5147b4]
- Updated dependencies [89cf8f8]
- Updated dependencies [54c5aec]
- Updated dependencies [8801b18]
- Updated dependencies [1b40406]
- Updated dependencies [b1c76c5]
- Updated dependencies [ca8af30]
- Updated dependencies [79ebf23]
- Updated dependencies [0dd7c6d]
- Updated dependencies [907894c]
- Updated dependencies [0a2c8c7]
- Updated dependencies [48dbb58]
- Updated dependencies [48dbb58]
- Updated dependencies [48dbb58]
- Updated dependencies [14f77fd]
- Updated dependencies [3db7ee9]
- Updated dependencies [81c8c07]
- Updated dependencies [727a371]
- Updated dependencies [3808410]
- Updated dependencies [7d8b5e6]
- Updated dependencies [12e430f]
- Updated dependencies [51386bd]
- Updated dependencies [78b5839]
- Updated dependencies [48dbb58]
- Updated dependencies [6a8c8c2]
- Updated dependencies [4d3ba56]
- Updated dependencies [6f057e5]
- Updated dependencies [493e2b5]
- Updated dependencies [36f7a76]
- Updated dependencies [d6be1ca]
- Updated dependencies [09ca0f1]
- Updated dependencies [ddc8b7a]
- Updated dependencies [ae6614c]
- Updated dependencies [8f57dc5]
- Updated dependencies [8f99bdf]
- Updated dependencies [d64fec1]
- Updated dependencies [727d95d]
- Updated dependencies [36b8646]
- Updated dependencies [48dbb58]
- Updated dependencies [3bf1481]
- Updated dependencies [48dbb58]
- Updated dependencies [48dbb58]
- Updated dependencies [61a9b45]
- Updated dependencies [d64fec1]
- Updated dependencies [60afafa]
- Updated dependencies [60afafa]
- Updated dependencies [d7bd476]
- Updated dependencies [48dbb58]
- Updated dependencies [48dbb58]
- Updated dependencies [48dbb58]
- Updated dependencies [d8d6880]
- Updated dependencies [8443cb8]
- Updated dependencies [81554ed]
- Updated dependencies [d6a33d1]
- Updated dependencies [8887ddb]
- Updated dependencies [d8d6880]
- Updated dependencies [820e6fd]
- Updated dependencies [d3c94f4]
- Updated dependencies [493e2b5]
- Updated dependencies [d54621c]
- Updated dependencies [e03f7ce]
- Updated dependencies [48dbb58]
- Updated dependencies [0bf279e]
- Updated dependencies [d1ce99d]
- Updated dependencies [d8d6880]
- Updated dependencies [3bf1481]
- Updated dependencies [aa3d4e2]
- Updated dependencies [d83f942]
- Updated dependencies [48dbb58]
- Updated dependencies [e4eb275]
- Updated dependencies [6b293f4]
- Updated dependencies [4f8f3ef]
- Updated dependencies [8e31941]
- Updated dependencies [a770ab4]
- Updated dependencies [6bf7f95]
- Updated dependencies [abcce55]
- Updated dependencies [509067a]
- Updated dependencies [55ee49f]
- Updated dependencies [28bde9d]
- Updated dependencies [36a7877]
- Updated dependencies [43540af]
- Updated dependencies [48dbb58]
- Updated dependencies [d03bd81]
- Updated dependencies [565846d]
- Updated dependencies [48dbb58]
- Updated dependencies [2272870]
- Updated dependencies [8a8156c]
- Updated dependencies [344ace8]
- Updated dependencies [40314af]
- Updated dependencies [1b8c0b7]
- Updated dependencies [5359178]
  - zelavis@2.0.0-alpha.3
