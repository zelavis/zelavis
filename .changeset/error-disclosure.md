---
"zelavis": patch
---

Stop returning internal exception messages to clients.

An unexpected failure now answers with a generic message and a correlation id
rather than the exception's own text, which routinely names filesystem paths,
module specifiers, SQL fragments, and internal service names. The full cause
still reaches the error lifecycle event, carrying the same correlation id, so an
operator can join a support report to the real error.

Useful errors are unchanged. A 4xx status means a mapping rule recognized the
failure as a problem with the caller's request, so validation and conflict
messages are returned verbatim; typed domain errors keep their message at any
status. Only unrecognized 5xx failures are genericized.

The Project child runtime answered every failure as a `400` carrying the raw
exception message, bypassing the policy entirely; it now uses the shared
mapping.
