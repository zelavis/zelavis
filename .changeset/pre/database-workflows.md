---
"zelavis": minor
---

Sagas across Tenants run on Effect's workflow model with a durable engine recorded in the database (`db.workflowEngine`): each completed step is recorded and never run again, compensations run on failure, unfinished executions resume after a restart, `tenantWriteActivity` writes each Tenant exactly once and `startFromOutbox` starts executions from a Tenant's outbox. Recorded executions are listed through `GET …/database/workflows/executions`, `client.projects.workflowExecutions` and `zelavis projects workflows`.
