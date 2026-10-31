---
"zelavis": minor
---

Durable Workloads. A job run is a message in its Tenant's mailbox, kept until the job's code has handled it
(`workloads run` enqueues it, with `tenantId`, `input`, `primaryKey` and `deliverAt`). A schedule's next wake is a
pending message saved before it is due and armed only where the database's writer runs; a fire missed during downtime
runs once. An inbound webhook (`POST workloads/webhooks/:projectId/:name`) is verified by an optional HMAC secret,
saved before it is answered and keyed by the provider's event id, so retries are recognised. An outbound webhook
delivers outbox messages with topic `webhook.<name>` to its `url` at least once with an `Idempotency-Key` header.
Webhook secrets are write-only. The entity runner now keeps an in-memory due index and sleeps until the earliest
due time instead of reading every partition each second; its `sweepInterval` is a five-minute safety net. The
delivery-guarantees page lists each channel.
