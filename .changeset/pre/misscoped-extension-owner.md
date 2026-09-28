---
"zelavis": minor
---

Name a capability owner written with the wrong scope marker, instead of letting
it fail silently.

A capability owner may be a bare service name (`zelavis/identity`) or a package
(`@acme/shop`), and both are legal. That means `@zelavis/identity` is a
perfectly valid owner which simply nobody is: it differs from the real service
by one character, never matches it, and produces no error. The extension is
grouped under an owner nothing reads, the settings page filtering on the real
owner drops it, and the symptom is a catalogue that is merely empty — the
failure the auth core's own source predicted before it was renamed.

The listing could not report it either, because an owner nobody answers to
looked exactly like one that is simply not installed yet: both were
`ownerInstalled: false`. Extension points now also carry `ownerKnown`, which
separates the two.

`misscopedExtensionOwners` reports an extension point whose owner becomes a real
service by adding or removing its scope marker, and a service discovered with
one is now warned about at startup, naming the capability it declared and the
owner it meant. It is deliberately narrower than "this owner is unknown":
extending a service that is not installed here is ordinary and is the common
shape of an unknown owner, so reporting those would bury the one case that is
always a mistake. The service still loads — the rest of the package is fine, and
refusing it would turn a typo into a Platform that will not start.
