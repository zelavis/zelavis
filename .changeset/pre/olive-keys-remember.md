---
"zelavis": minor
---

Document writes accept an idempotency key, so a retry is answered rather than
applied twice.

The API being replaced took a key when appending an event. There is no append
here — writes reach the log only through the documents API — so the guard
belongs where the write enters. `insert`, `update` and `delete` take an optional
`idempotencyKey`, and a repeat carrying it returns what the first attempt
returned.

The receipt is written in the same transaction as the change it describes.
Recorded afterwards, there would be a window in which the write had happened and
the key had not been noted, which is exactly the window a retry falls into.

A key offered for a different request is refused with `IdempotencyKeyReused`
rather than answered with the stored outcome, an attempt that failed spends no
key, and `forgetIdempotencyKeys` sweeps receipts — they grow with requests
rather than with data, and how long a retry may arrive is the caller's question.
