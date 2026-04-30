# @zelavis/database

`@zelavis/database` provides the core database contracts and document primitives for Zelavis.

## Current role

The package is event-first internally.

Current public shape centers on:

- documents
- events
- schemas
- projections
- time-series
- optional SQL capability

## Important current constraints

Current non-goals for the first slice include:

- built-in SQLite dependency in core
- replication
- offline sync
- distributed transactions

## Current design direction

- document APIs remain the main ergonomic surface
- writes append events
- reads come from projections
- projections are explicit public contract metadata
- time-series builds on that explicit model

## Related docs

- [@zelavis/server](./server.md)
- [@zelavis/auth](./auth.md)
- [Reference](../reference/index.md)
