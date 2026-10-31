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
| Workflows (`db.workflowEngine`) | Activities at least once | A recorded activity never runs again; `tenantWriteActivity` keys each Tenant write by execution and step |
| Leader transport (followers on other hosts) | At least once | Entries carry the leader's positions; a repeated position is compared and skipped, a gap or a different entry is refused |
| Follower acknowledgments | At least once | Positions only rise, so a late or repeated acknowledgment changes nothing |
| Cross-Tenant index refresh | At least once per log entry | Entries and the partition's cursor commit together |
| Gateway envelopes (Platform to Project) | At most once | A nonce per envelope; a replay is refused |
| Agent dispatch (signed Project and host operations) | At most once per authority | Single-use authority and a replay store on the Agent |
| SDK retries | Only idempotent requests are retried | Methods that change state are not retried by the client |

A new channel states its row here before it ships. The reasoning, and what Zelavis took from Effect Cluster, is in the
repository's decision record (`.agents/references/effect-cluster-decision.md`).
