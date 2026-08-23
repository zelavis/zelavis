---
title: "@zelavis/db"
---
`@zelavis/db` provides the core database contracts and document primitives for Zelavis.

## Current role

The package is event-first internally.

Current public shape centers on:

- documents
- events
- schemas
- native file-reference schema fields
- projections
- time-series
- optional SQL capability

## Important current constraints

Current non-goals for the first slice include:

- built-in SQLite dependency in core
- replication
- offline sync
- distributed transactions

These are current non-goals, not permanent product limits. Replication,
sharding, and eventually distributed multi-master operation are explicit future
goals.

## Current design direction

- document APIs remain the main ergonomic surface
- writes append events
- reads come from projections
- projections are explicit public contract metadata
- time-series builds on that explicit model
- collection schemas can now validate Zelavis-style file references with `type: "file"` or helpers such as `imageFileSchema(...)`, `audioFileSchema(...)`, `videoFileSchema(...)`, and `documentFileSchema(...)`
- editor-facing content models can mark rich-text HTML fields explicitly with `richTextHtmlSchema(...)`, which the dashboard maps to Lexical while the stored value remains plain HTML

## Future distribution constraints

Until replication and multi-master support exist, database work should avoid
baking in hidden single-node assumptions.

- The event log is the future replication stream.
- Event application should stay deterministic and replayable.
- Idempotency keys and event origin metadata should remain first-class.
- `tenant_id` should remain explicit on durable state and query boundaries.
- Collection tables should remain projections, not the source of truth.
- Replication, routing, and conflict-resolution contracts should remain
  adapter-neutral.

## Related docs

- [@zelavis/server](./server.md)
- [@zelavis/auth](./auth.md)
- [Service Authoring](../guides/service-authoring.md)
- [Reference](../reference/index.md)
