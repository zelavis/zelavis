---
"zelavis": patch
---

Release 2.0.0-alpha.5.

2.0.0-alpha.4 cannot be published: the registry holds a staged entry under that
version, and staged and published versions share one semver index, so every
attempt answers 409 "Cannot publish over previously staged version". The entry
is not visible to `npm stage list` for the publishing account, so there is
nothing to approve or reject. The version number is spent.
