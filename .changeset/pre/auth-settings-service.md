---
"zelavis": minor
"@zelavis/auth": minor
---

Add the auth settings page as a product service, and stop a stale session
cookie from locking people out.

`@zelavis/auth` is a page, not an auth implementation. Accounts, sessions,
credentials, password verification and the OAuth flow stay in Zelavis, where an
installation cannot run without them. What a package can usefully own is the
face: a settings page showing how people sign in, the OAuth providers
configured for this installation, and a catalogue of the plugins that extend
auth — scoped to `zelavis/auth`, because a general list of everything
installable does not say which of it is a sign-in method.

Removing it costs the page, not the ability to sign in. It ships beside
`@zelavis/ui` and `@zelavis/marketplace` and is loaded through the same plugin
loader an installed third-party service goes through, so its menu reaches the
dashboard through the ordinary extension path rather than a private one.

Core auth no longer contributes its own dashboard menu. With both contributing
one, the sidebar carried two "Auth" entries and the one without a page led
nowhere.

Fixes a lockout: a session cookie that no longer resolves — expired, revoked,
or left over from another installation on the same host — made the request fail
outright, so the public sign-in and bootstrap endpoints answered 401 and the
only way through was clearing cookies by hand. A cookie is ambient, attached by
the browser whether or not the caller meant to authenticate, so one that does
not resolve now means "not signed in". A bearer token is an assertion the
caller chose to make, and an invalid one is still an error.

Discovery failures also name the URL that could not be reached, rather than
surfacing the transport's "fetch failed".
