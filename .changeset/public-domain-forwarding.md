---
"zelavis": minor
---

Forward verified public domains to the Project that owns them.

A request arriving on a verified bound domain is forwarded to that Project,
choosing its running server frontend when there is one and falling back to the
Project runtime otherwise.

Forwarding is anonymous. A visitor has no Platform identity and the target may
be third-party frontend code, so no Platform credentials are relayed and no
authority envelope is signed or sent. Only a verified binding is routable:
anyone can point DNS at a host, and verification is what proves the operator
controls it.

The Project's own `set-cookie` is preserved, unlike on the Gateway path, because
the response is served from the Project's own domain rather than the Platform
origin. The Project's control plane is not published on a bound domain.

An unbound host falls through to the installation's own root behaviour, and a
stopped Project answers `503` rather than hanging.
