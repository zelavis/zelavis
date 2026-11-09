---
"zelavis": minor
---

The SDK client gains deadlines (`timeoutMs`), cancellation (`signal`), opt-in retries that repeat only idempotent requests or writes carrying an idempotency key (Effect `Schedule`, exponential backoff with jitter), typed failures (`ZelavisClientHttpError` with `code`, `operation` and `retryable`; `ZelavisClientTransportError`; `ZelavisClientAbortError`) and `pages()` for every cursor-paged operation.
