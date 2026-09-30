---
title: Marketplace Allow-List
---
The marketplace does not host code. Services live on npm, and `@zelavis/marketplace`
owns the **allow-list**: which packages an installation may install, at exactly
which versions, and the digest each must have. Installing a service executes its
code with Platform authority, so "is this on the list" is the trust decision, and
the design exists to make that answer trustworthy.

## The list

A list is a signed JSON envelope:

```json
{ "keyId": "…", "payload": "<base64url of the list>", "signature": "<base64url Ed25519>" }
```

The payload is `{ schemaVersion: 1, sequence, issuedAt, expiresAt, services: […] }`.
Each service names its npm package, kind (`app`, `plugin` or `frontend`),
maintainer, marketplace card, and its exact versions with the sha512 integrity of
each published tarball. A range or a tag is never a listed version.

## Why it can be fetched from anywhere

The list is signed, so a copy from a mirror, a gist or an API is exactly as
trustworthy as one from the primary. An installation is given several sources and
uses the first that answers with a list it accepts. A source can never move it
backwards:

- **Signature.** Only keys the installation trusts. Anything else is skipped.
- **Sequence.** Strictly increasing. A validly signed list older than one already
  held is a replay (it could re-open a service that was removed) and is ignored.
- **Expiry.** After `expiresAt` the list is stale for seven days (nothing new is
  installed, but running services are untouched) and then expired.
- **Transport.** https only, no redirects, bounded size and time.
- **Cache.** The last accepted list is kept in the System Store and verified again
  on every read, so an outage changes nothing and an edited cache is ignored.

The list shipped with a release is a floor and a last resort.

## The install gate

When the gate is on (the default), an npm install must name an exact listed
version, is refused before anything is fetched if it is not listed, and is refused
after download if the bytes do not have the listed digest. Other source kinds are
refused unless the operator configured them explicitly. `allowlist: false` in the
adapter's `services.marketplace` option removes the gate and leaves only the
explicit source policy.

## Development

In a repository checkout, `ZELAVIS_OFFICIAL_SERVICES_DIR` (set by `pnpm dev`) points
at `zelavis-services/`. An official service that is not installed is offered from
there instead of from npm, so it can be tried without publishing anything. It only
ever names packages in the operator's own checkout.

## Operating it

```txt
GET  /zelavis/api/v1/runtime/marketplace/allowlist          how current the list is (marketplace.view)
POST /zelavis/api/v1/runtime/marketplace/allowlist/refresh  fetch it again (system.services.manage)
```

SDK: `client.marketplace.allowlist()` and `client.marketplace.refresh()`.
CLI: `zelavis marketplace allowlist` and `zelavis marketplace refresh`.

Sources come from `services.marketplace.sources` or `ZELAVIS_ALLOWLIST_SOURCES`
(comma separated). Trusted keys are the official ones plus
`services.marketplace.keys`. A newer list applies to the catalogue at the next
start. Until the official list and its signing key are published there are no
default sources and the trusted-key list is empty, so only the shipped list counts.

## Publishing the list

Releases run `pnpm allowlist update`, which rebuilds the list from the packages in
`zelavis-services/*` and the digests npm serves for them, raises `sequence` and
rewrites the list shipped with the release. `pnpm allowlist sign` then signs it
with the release key (kept outside the repository) into the file every source
hosts. By default installations fetch `https://zelavis.com/allowlist.json` and a
mirror on GitHub; both hold the same signed file, so either one is enough.
