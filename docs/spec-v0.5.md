# Zelavis Target Specification and Implementation Order v0.5

This document replaces vague future-state notes with a single working spec.

It does two things:

1. defines the intended Zelavis architecture
2. tracks the implementation order from the current foundation to that target

It is intentionally split into:

- current baseline
- target system
- ordered implementation backlog

Related design docs:

- [API Design v0.1](api-design-v0.1.md)

---

## 1. Purpose

Zelavis is evolving toward a self-hostable, embeddable, event-first backend platform with:

- a document-first developer API
- versioned schemas and validation
- projection-driven secondary models
- optional time-series support
- runtime-neutral core packages
- pluggable storage and transport
- eventual multi-node replication

The core rule remains:

> The event log is the source of truth. Documents, time-series views, and future models are projections or services built on top of that foundation.

---

## 2. Current Baseline

These capabilities already exist in the repo today.

### 2.1 Database core

- event-first internal write flow
- projection-backed document reads
- collection CRUD and query support
- tenant-aware document operations
- runtime-neutral core package design

### 2.2 Schema system

- collection schema registration
- schema versioning
- active schema selection per collection
- write-time validation for inserts and updates
- persisted schema registry in in-memory and SQLite-backed drivers
- schema management HTTP routes
- schema management UI in the dashboard

### 2.3 Storage

- in-memory driver
- Node SQLite driver
- Bun SQLite driver
- optional SQL capability exposed by SQLite-compatible drivers

### 2.4 Runtime/UI

- dashboard integration through `@zelavis/ui`
- database service mounting through `@zelavis/server`
- schema inspection and activation UI in the database page

### 2.5 Not implemented yet

- generalized projection engine
- idempotency layer
- event transport format such as Protobuf
- browser storage runtime
- replication and sync protocol
- time-series model
- peer/node coordination
- retention/downsampling/partitioning for derived models

---

## 3. Product Direction

### 3.1 External product shape

Zelavis should feel like:

- a document-first backend foundation
- self-hostable and embeddable
- schema-aware
- extensible through services, adapters, and plugins

### 3.2 Internal architecture shape

Internally, Zelavis should remain:

- event-first
- projection-based
- runtime-neutral
- multi-model capable over time

### 3.3 v1 priority

The v1 priority is not “distributed everything”.

The v1 priority is:

1. strong event foundation
2. strong document API
3. strong schema system
4. extensible projection model
5. first useful derived model: time-series

Replication and broader node equality should come after those foundations are explicit and stable.

---

## 4. Core Architecture Rules

### 4.1 Event-first

All mutations are represented as events.

Requirements:

- immutable append-only event records
- deterministic replay behavior
- schema version stamped on relevant events
- revision or concurrency control for stream updates

### 4.2 Document-first API

Documents remain the main ergonomic API.

Requirements:

- collections
- CRUD operations
- query support
- schema enforcement at write time
- projection-backed reads

### 4.3 Projection-based expansion

New models should not bypass the event foundation.

Requirements:

- new models derive from events
- projections must be explicit and inspectable
- driver integrations can persist projection state
- the document model itself remains a projection-backed surface

### 4.4 Runtime neutrality

Core packages must depend only on TypeScript, ECMAScript, and standard platform APIs.

Requirements:

- no Node-only architecture in core
- no Bun-only architecture in core
- no framework-specific request/response coupling in core
- host-specific logic belongs only in `integrations/*`

### 4.5 Storage abstraction

Storage must remain pluggable.

Requirements:

- in-memory baseline
- SQLite as current durable baseline
- future adapters can add Postgres/libSQL/IndexedDB/etc.

---

## 5. Target Core Model

### 5.1 Event model

The event model should continue to include the current essentials and grow carefully.

Required fields:

- `eventId`
- `nodeId`
- `tenantId`
- `collection`
- `documentId?`
- `type`
- `revision`
- `timestamp`
- `schemaVersion`
- `payload`

Planned additions:

- `idempotencyKey?`
- `causationId?`
- `correlationId?`
- `source?`
- `projectionHints?` only if truly needed

Rule:

- do not expand the event envelope casually
- each new field must solve a concrete replay, sync, or operational problem

### 5.2 Schema model

Schemas are collection-scoped and versioned.

Requirements:

- structural validation
- optional custom validation hooks
- persisted schema versions
- explicit active version selection
- schema-aware document writes

Planned later:

- migration metadata
- compatibility metadata
- read-time upgrade helpers
- schema evolution tooling

### 5.3 Document model

Documents remain the default user-facing model.

Requirements:

- projection-backed reads
- revision tracking
- stamped `schemaVersion`
- tenant-aware isolation

### 5.4 Time-series model

Time-series should be introduced as a native projection-based model.

Definition:

> Time-series is a projection of event data indexed by timestamp.

Requirements:

- named time-series definitions
- projection mapping from events to samples
- range queries
- basic aggregations: `avg`, `sum`, `min`, `max`, `count`

Planned later:

- retention policies
- downsampling
- partitioning

---

## 6. Target Public API Direction

The public API should be designed before major new subsystems are added.

Target shape:

```ts
const app = await zelavis({
  database: { ... },
  auth: { ... },
})

const db = app.database

await db.documents.createCollection({ name: 'products' })
await db.documents.insert({ collection: 'products', data: {...} })
await db.schemas.register({ collection: 'products', version: 1, document: {...} })

await db.events.read({ collection: 'products' })

await db.projections.register({ name: 'timeseries.metrics', ... })

await db.timeseries('metrics').range({ start, end })
await db.timeseries('metrics').aggregate({ op: 'avg', start, end })
```

This does **not** mean all of these APIs exist yet.
It means future implementation should be guided by a stable intended surface.

---

## 7. Transport and Sync Direction

These are target capabilities, not current ones.

### 7.1 Event transport

A structured transport format should be added when inter-node sync becomes real.

Preferred direction:

- Protobuf or similarly explicit binary/event contract

Do not implement transport first.
Implement it only once the sync envelope and node protocol are clear.

### 7.2 Idempotency

Idempotency should be added before distributed sync.

Requirements:

- dedupe repeated write submissions
- preserve safe retries across transports and adapters
- work at the event append boundary

### 7.3 Replication

Replication should be event-stream based.

Requirements:

- stream reads after sequence/checkpoint
- checkpoint exchange
- replay on receiving side
- deterministic projection rebuild

Not required for the next step:

- multi-master conflict policy beyond current revision controls
- full mesh sync topology

---

## 8. Implementation Strategy

This is the ordered plan to move from the current codebase to the target architecture without losing focus.

---

## 9. Ordered Implementation Backlog

Work these in order.
Do not skip ahead unless a dependency forces it.

### Phase A — Lock the public contracts

#### A1. Finalize the database-facing TypeScript surface

- [x] define the intended public API for `events`, `documents`, `schemas`, `projections`, and future `timeseries`
- [x] document what is implemented now vs reserved for later
- [x] keep names compatible with current package direction

#### A2. Write contract-first docs

- [x] add examples for the intended API shape
- [x] define stable input/output types at a spec level
- [x] avoid transport/storage details in public-facing examples

#### A3. Identify internal vs public contracts

- [x] separate user-facing APIs from lower-level driver/projection contracts
- [x] mark unstable internal contracts clearly

---

### Phase B — Complete the event foundation

#### B1. Add idempotency support

- [x] add optional `idempotencyKey` to event append inputs
- [x] define dedupe semantics
- [x] implement support in in-memory and SQLite drivers
- [x] test repeated writes and retry safety

#### B2. Improve event stream semantics

- [ ] define stream boundaries clearly: collection stream vs document stream vs global tenant stream
- [ ] define checkpoint/read models for future sync
- [ ] document replay expectations

#### B3. Add event metadata hooks carefully

- [ ] evaluate `causationId` and `correlationId`
- [ ] add only if needed for observability or workflow chaining

---

### Phase C — Generalize projections

#### C1. Introduce a projection registry contract

- [x] define how projections are registered
- [x] define replay/apply lifecycle
- [x] keep the core runtime-neutral

#### C2. Make document projection explicit

- [x] treat the current document projection as the first built-in projection
- [x] document its responsibilities separately from the event log

#### C3. Define projection persistence expectations

- [ ] specify what drivers must store for projection state
- [ ] define rebuild behavior from events

---

### Phase D — Add first-class time-series support

#### D1. Define time-series contracts

- [x] specify sample shape
- [x] specify mapping from events to time-series samples
- [x] specify range and aggregation query contracts

#### D2. Implement a minimal time-series service

- [x] add a `timeseries` service in `@zelavis/database`
- [x] support named series definitions
- [x] support range queries
- [x] support `avg`, `sum`, `min`, `max`, `count`

#### D3. Add SQLite-backed persistence for time-series projections

- [x] create projection tables/indexes
- [x] define rebuild behavior
- [x] validate query correctness

#### D4. Add server routes and dashboard UI

- [x] list available series
- [x] inspect recent samples
- [x] run simple aggregations

---

### Phase E — Prepare browser/runtime expansion

#### E1. Define a browser storage adapter contract

- [ ] choose IndexedDB baseline
- [ ] keep WASM SQLite optional
- [ ] align with current driver abstractions where possible

#### E2. Define local-first behavior

- [ ] local append behavior
- [ ] local projection updates
- [ ] later sync hooks

#### E3. Keep runtime-specific code out of core

- [ ] browser-specific storage only in integrations/adapters
- [ ] no browser assumptions in core database services

---

### Phase F — Add sync and node capabilities

#### F1. Define node identity properly

- [ ] distinguish runtime instance identity from deployment identity
- [ ] document node metadata requirements

#### F2. Define replication protocol shape

- [ ] checkpoint exchange
- [ ] event pull/push strategy
- [ ] replay behavior
- [ ] failure and retry semantics

#### F3. Add first sync implementation

- [ ] start with simple one-way or client/server sync
- [ ] do not begin with full peer mesh
- [ ] validate deterministic rebuilds and idempotent replay

---

### Phase G — Advanced derived-model features

#### G1. Time-series retention

- [ ] retention policy definitions
- [ ] pruning behavior

#### G2. Downsampling

- [ ] rollups by interval
- [ ] query strategy for raw vs rolled-up reads

#### G3. Partitioning

- [ ] define partition strategy only after query patterns are known

---

## 10. Immediate Next Work Recommendation

The next implementation step should be:

### 10.1 Next task

Define the final developer-facing TypeScript API for the database package and the future projection/time-series surface.

### 10.2 Why this is next

Because the repo now has enough foundation that the next risk is API drift, not storage gaps.

If the API is not locked first, later work on:

- idempotency
- projections
- time-series
- browser runtime
- replication

will likely force unnecessary rewrites.

### 10.3 Deliverables for the next task

- one API design doc — completed in [API Design v0.1](api-design-v0.1.md)
- one set of TypeScript types/interfaces — initial public interface layer added in `@zelavis/database`
- one small example section showing intended usage
- explicit labels for `implemented now`, `next`, and `reserved`

---

## 11. Guardrails

When implementing future steps:

- prefer small, coherent slices
- keep core packages runtime-neutral
- do not add heavy dependencies without clear value
- treat documents as the main user-facing API until time-series is actually useful
- add tests with each contract-level expansion
- update docs whenever a public contract changes

---

## 12. Summary

Zelavis should be built in this order:

1. lock public API
2. complete the event foundation with idempotency
3. generalize projections
4. add time-series as the first new projection-based model
5. add browser/local-first storage
6. add sync and replication

That path preserves the current strengths of the codebase while moving directly toward the architecture described in the earlier notes.
