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

Writer leases and follower failover. A partition's writer lease (`{ owner, epoch, expiresAt, acknowledgedHead }`,
changed only by compare-and-set) gates every change to the partition, so a writer that was paused past its lease is
refused at its first write, before any follower may be promoted. A follower is promoted only when the lease has
expired or been released and its copy holds the highest acknowledged position (`allowDataLoss` reports what may be
lost); one compare-and-set raises the epoch. `db.writerLeases.hold|standby`, `GET followers/:partition/lease`,
`POST followers/:partition/lease/promote|demote`, `client.followers(projectId).lease|promote|demote` and
`zelavis followers lease|promote|demote`. A leased partition cannot be moved or removed until released. The Fabric
planner never plans more than one replica of a runtime that holds a database. Inbound webhooks accept timestamped
signatures (`signatureScheme: "timestamped"`), and the workload runner no longer polls: it is woken by definition
changes, outbox commits and due times.

The Platform serves the writer-lease authority at `/runtime/writer-leases/:partition`, with `httpLeaseStore`,
`client.writerLeases` and `zelavis leases` for runtimes on other hosts. `pnpm release:qualify:failover` qualifies
failover in separate containers (a `SIGKILL`, a partition and an unacknowledged tail). Requests to a leader are now
interruptible, so a follower whose leader is partitioned can still be stopped and a standby promoted.

Followers find the new writer from the lease alone (`endpoint`, `db.writerLeases.follow`), accepting data loss in a
promotion needs `database.failover.accept-data-loss`, and the Platform audits every change of writer
(`GET /runtime/writer-lease-audit`, `client.writerLeases.audit()`, `zelavis leases audit`).
