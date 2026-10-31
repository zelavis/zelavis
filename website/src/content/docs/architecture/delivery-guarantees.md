---
title: Delivery guarantees
description: What each channel in Zelavis promises about delivery, and how its receivers make repeats harmless.
---

No network delivers a message exactly once: a sender cannot tell a lost message from a lost acknowledgment, so it must
either give up (at most once) or resend (at least once). Zelavis never claims exactly-once delivery. Where it promises
exactly-once *effects*, it is because the receiver recognises a repeat, or because the effect and the record that it
happened commit together.

| Channel | Guarantee | What makes a repeat harmless |
|---|---|---|
| Document writes (`documents.write`, `insert`, …) | At least once when retried with an `idempotencyKey` | The key's receipt commits in the same batch as the write; a repeat answers the first result |
| Outbox (`emit`, `documents.write({ emit })`) | At least once to consumers | Each message keeps its id; consumers deduplicate by id and remove what they handled |
| Durable entities (`entities.send`, `serve`) | At least once to handlers | A message's `primaryKey` dedupes resends; a step's writes commit only with the processed mark, so database effects land once |
| Jobs (`workloads run`) | At least once to the job's code | A run is a durable entity message; a `primaryKey` makes a resend the same run, and the run's writes commit with its processed mark, so database effects land once |
| Schedules | A fire runs at least once; a missed fire runs once | The next wake is a pending message keyed by its fire time, armed only where the database's writer runs; the code's database effects commit with the mark |
| Inbound webhooks | Saved before the provider is answered; at least once to the code | The provider's event id is the `primaryKey`, so its retry is recognised (`duplicate: true`) and a `2xx` means the event is kept; a full mailbox answers `503` so the provider retries |
| Outbound webhooks | At least once to the receiver | Every request carries the outbox message id as `Idempotency-Key`, unchanged across retries; the receiver deduplicates by it. The message is removed only after a `2xx` |
| Workflows (`db.workflowEngine`) | Activities at least once | A recorded activity never runs again; `tenantWriteActivity` keys each Tenant write by execution and step |
| Leader transport (followers on other hosts) | At least once | Entries carry the leader's positions; a repeated position is compared and skipped, a gap or a different entry is refused |
| Writer lease renewal and promotion | Compare-and-set; at most one writer per epoch | Every change is conditional on the observed lease; a stale writer's renewal fails and its gate refuses its writes; a promotion raises the epoch and requires the follower to hold the highest acknowledged position |
| Follower acknowledgments | At least once | Positions only rise, so a late or repeated acknowledgment changes nothing |
| Cross-Tenant index refresh | At least once per log entry | Entries and the partition's cursor commit together |
| Gateway envelopes (Platform to Project) | At most once | A nonce per envelope; a replay is refused |
| Agent dispatch (signed Project and host operations) | At most once per authority | Single-use authority and a replay store on the Agent |
| SDK retries | Only idempotent requests are retried | Methods that change state are not retried by the client |

The entity runner keeps its due times in memory (partition to earliest due time, built by one scan at start and kept
current by sends, retries and cancels), so it sleeps until something is due; a rare full scan is only a safety net for
what another process sent. This changes when a message is picked up, not what is promised about it.

A new channel states its row here before it ships. The reasoning, and what Zelavis took from Effect Cluster, is in the
repository's decision record (`.agents/references/effect-cluster-decision.md`).
