---
title: Marketplace Allow-List
---
The marketplace does not host code. Services live on npm, and `@zelavis/marketplace`
owns the **allow-list**: which packages an installation may install, at exactly
which versions, and the digest each must have. Installing a service executes its
code with Platform authority, so "is this on the list" is the trust decision, and
the design exists to make that answer trustworthy.

## The list

A list is a plain JSON document:

```json
{ "schemaVersion": 1, "sequence": 13, "issuedAt": "…", "expiresAt": "…", "services": […] }
```

Each service names its npm package, kind (`app`, `plugin` or `frontend`),
maintainer, marketplace card, and its exact versions with the sha512 integrity of
each published tarball. A range or a tag is never a listed version.

Each version also names `platform`: the oldest Zelavis it runs on, exact, taken
from that version's own `peerDependencies.zelavis` (which must be `>=` an exact
version). One list is read by every installation, old ones too, so it also lists
versions an older Platform cannot run. An installation is offered each service at
the newest version its own Zelavis runs (`latest` when it can, otherwise the newest
earlier version that is not deprecated), and installing, updating and the recipe a
new Project or an upgrade takes all follow that choice. The gate refuses a version
that needs a newer Platform before anything is fetched, and says which Zelavis it
needs: update the Platform first, then install it. A service none of whose versions
runs is still listed at its latest, so it can be found. A Project's marketplace
decides by the Zelavis its own engine runs. Platforms released before `platform`
existed ignore the field and are offered `latest` whatever it needs.

## Where it comes from, and why that is trusted

The list is served over https from `https://zelavis.com/allowlist.json`, and that
origin is the trust anchor, the same as for the installer, which is fetched from
the same site. There are no keys, signatures or envelopes: what https from
zelavis.com serves is what the project publishes. Sources come from
`services.marketplace.sources` or `ZELAVIS_ALLOWLIST_SOURCES` (comma separated);
each is trusted exactly as much as its own https origin, so an operator adds one
only when they trust whoever serves it. They are tried in order and the first
acceptable list wins. Whatever a source serves, it can never move an installation
backwards:

- **Sequence.** Strictly increasing. A list older than one already held is a replay
  (it could re-open a service that was removed) and is ignored.
- **Expiry.** After `expiresAt` the list is stale for seven days (nothing new is
  installed, but running services are untouched) and then expired.
- **Transport.** https only (plain http only for `localhost`), no redirects, at
  most 512 KiB, and ten seconds per source.
- **Format.** Every list is validated before it is used; a malformed one is skipped.
- **Cache.** The last accepted list is kept in the System Store and parsed again on
  every read, so an outage changes nothing and an edited cache is ignored.

The list shipped with a release is a floor and a last resort: a list held with a
lower sequence never replaces it. The Platform refreshes in the background at
start and every six hours. A newer list applies to the catalogue at the next start;
until then, and when no source answers, the newest held list (the shipped one or
the cached one) counts.

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

## Updating an installed service

An installed service the list offers at a newer version carries
`update: { version }` in `GET /zelavis/api/v1/runtime/services`, and the Marketplace
shows **Update to** that version. Updating installs the listed version through the
same gate as an install:

```txt
POST /zelavis/api/v1/runtime/services/:name/update   install the listed version (system.services.manage)
```

The version is the list's, never the caller's, the same rule as for Platform
updates. The answer is `409` when the installed version is already the newest
listed. The running Platform serves the new version at once, with no restart: a
plugin or frontend is activated as on install, and a recipe is read live, so its
Projects offer **Upgrade** to it straight away. Upgrading each Project stays a
separate, explicit action.

SDK: `client.marketplace.services()` and `client.marketplace.update(name)`.
CLI: `zelavis marketplace updates` and `zelavis marketplace update <name>`.

A Project recipe (`kind: "app"`) needs none of this. A recipe never runs from
its installed copy, because every Project freezes its own, so creating a Project
from a recipe or upgrading one first installs the newest version the list names,
when that version is not installed yet. The Marketplace therefore shows **Update**
only for plugins and frontends. Each Project still moves to a newer recipe only
when someone upgrades it.

## Publishing the list

Services and the Platform are published in one run, and the Platform ships the
list. `pnpm allowlist update` rebuilds it from the packages in `zelavis-services/*`,
raises `sequence` and rewrites the list shipped with the release. A version npm
already has is listed with npm's digest; one npm does not have yet is listed with
the digest of its local `pnpm pack`, because packing is deterministic and npm's
digest is the digest of the uploaded tarball. The publisher then packs every
pending package and refuses, before publishing anything, a service tarball whose
digest is not the listed one, so what npm serves is exactly what the shipped list
vouches for. It publishes a changed service only together with the Platform that
lists it. `pnpm allowlist check` is part of release validation and refuses defaults
that differ from the qualified service versions.

After that publish, `pnpm allowlist publish` writes a plain copy with a fresh expiry
(90 days by default) to `website/public/allowlist.json`, and the next website deploy
serves it at `https://zelavis.com/allowlist.json`. A fresh runtime composes its
catalogue from the shipped list; a refreshed one applies at its next start.

## Projects

A Project has a marketplace of its own for the plugins and frontends installed into
it, behind the same install gate. It never fetches the sources. The Platform hands
its list to each Project (in the Project's data folder, on every refresh and
whenever the Project starts), and the Project parses it again on every read, so a
malformed file is refused. The Platform is the Project's parent authority and the
folder is the Project's own, which is the same trust a Project already places in the
Platform. A Project that has been given nothing uses the list shipped with its release.
