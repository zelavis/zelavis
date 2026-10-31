---
"zelavis": minor
---

Durable entities: actors whose mailbox and state live in their Tenant's partition. `tenant.entities.send` keeps a
message until a handler has processed it, one at a time per entity in arrival order; a handler's document writes,
outbox messages, new state and reply commit with the message's processed mark, so its database effects land exactly
once over at-least-once delivery, across crashes. A `primaryKey` dedupes resends, `deliverAt` delays a message,
failed attempts are retried with a doubling pause and then marked `failed`, messages can be cancelled, and a mailbox
holds at most 4096 unfinished messages. `db.entities.serve` runs handlers by type; in a Project the enabled `entity`
workloads are the handlers. HTTP `…/database/entities/*`, `client.data(projectId).entities`, `zelavis entities`, and
an entity workload's dashboard page show its entities, state and mailbox and send messages. The docs gain a table of
what every channel promises about delivery.
