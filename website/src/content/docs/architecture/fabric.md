---
title: Fabric and Placement
description: How Zelavis decides where a Project runs, and what is and is not operational today.
---

Zelavis separates deciding from doing. The **Fabric** decides where work runs.
**Agents** carry it out on a machine. Neither is the other's job, and a proxy or a
process supervisor is neither.

## Two fabrics, one authority

- The **Platform Fabric** is the one privileged hosting authority. It owns
  physical Nodes, which Project runs where, routing, the generation (epoch) that
  fences an old owner, and fleet policy.
- The **App Data Fabric** lives inside a Zelavis App Project. It owns how a
  Tenant's data is partitioned across virtual shard ranges and physical SQLite
  files. It may ask the Platform for capacity. It never picks a Node itself.

The hierarchy is: the Platform scales Projects, Projects scale Tenants, and an
exceptional Tenant scales by being divided into parts that each route and store
as a Tenant of their own. A child knows its parent and never becomes it.

## Placement is a record, not a guess

A Project's placement is a compare-and-set record in the System Store:
`{ owner, epoch }`. Starting a Project requires a committed placement, and only
the current epoch may act.

- A **lease supervisor** on the local Agent verifies the committed placement
  before starting a Project process, and stops it when the placement expires or
  changes.
- A plan from the scheduler alone never starts anything. Authority comes from the
  committed record.
- A runtime URL reported by an Agent is a route target. It is never evidence of
  who owns the Project.

## Remote start

Starting a Project on another machine is implemented end to end. The Platform
signs authority that is bound to the destination and usable once, plus a
short-lived placement grant. A worker Agent on a pinned-CA HTTPS endpoint checks
both against its own durable high-water mark and replay store, fences the previous
owner before accepting a newer one, and installs the frozen recipe and descriptor
from a digest-verified snapshot before starting the Project. A test runs a real,
locked App Project through this path.

Not yet proven: network-partition drills across several real hosts, and Bun as
the Agent runtime.

## Bounded, retryable reconciliation

Reconciliation is bounded, asynchronous, idempotent and safe to retry. It never
restores every desired-running Project at once, and control-plane readiness never
waits for a whole fleet to start. The built-in Node process driver is the
development and small single-host mode: the Platform owns its children and stops
them when it closes. Production worker Agents are supervised separately, so
customer runtimes survive a control-plane restart while staying under one logical
Platform authority.

## Replicas and scale

Replica policy does not depend on topology. The same plan holds whether one Node
or many are available: replicas share a Node when they must and spread when
capacity appears. Spare capacity never creates demand. Scaling follows explicit
fixed intent or Project-level load, within declared limits. A runtime driver that
does not advertise stateless replicas stays single-replica. Replicas never imply
more than one writer.

## What is not operational

- **A replicated System Store.** Shard grants still depend on the Platform. Lease-guarded Projects also require a separate
  design for remote shards.
- **Project Cells.** A Project that manages nested Apps inside its own allocation
  is a design direction. The parent would place the whole cell as one group and
  keep provider and Node authority.
- **Distributed drivers.** Leases and fencing, durable work queues,
  health-based placement and paginated Project discovery are needed before a
  multi-host scheduler. The in-process child map must not be stretched into one.

## Shards on other Nodes

An official App Project can place some of its virtual ranges on a shard whose storage another Node hosts, and give it
back. The App asks, the Platform decides the Node and commits a grant at an epoch that only rises, the Agent on that
Node hosts the shard as a SQLite file under its data directory, and the App moves Tenants into it with the relocation
it already uses (copy, fenced catch-up, routing moved last). A shard's bytes never move between Nodes in place; moving
a shard from one Node to another is a new shard there and a release of the old one.

To enable it:

1. Give the Platform remote Nodes (`projects.remoteDispatch`) and set `ZELAVIS_APP_SHARDS_URL` to the Platform's API
   root as a Project process sees it (for example `http://127.0.0.1:3000/zelavis/api/v1`).
2. Set the Project's allocation (below).
3. Place and release through the Project's Database → Shards page, `client.shards(projectId)`, `zelavis shards` or
   `POST database/shards/place` and `POST database/shards/:shardId/release` ([database API](../api/database.md#shards-on-other-nodes)).

Two fences keep one writer: the Agent refuses every call whose signed 120-second access token is not at its durable
epoch for a committed shard, and the store still checks its writer generation in every write. A restart of the Project
raises the epoch, so a previous process cannot use the shard. Deleting a Project revokes its shards at their Agents
before its data goes, and retries while an Agent is unreachable.

**Replicas.** A local or remote shard can have one durability copy on a different Node. Use Database → Shards or the
[shard API](../api/database.md#shards-on-other-nodes) to add or remove one. Its disk reservation counts against the
Project allocation. The Project writer keeps the copy current from the primary's partition logs and reports its
status and lag. The copy stays outside Tenant routing, scatter, upkeep and backups. Primary writes complete independently
of the replica. Recovery from a replica, promotion and serving reads from it require separate support. Remove the
replica before releasing a remote primary. Project deletion removes both placements.

Limits:

- The Platform is a single point of failure for shard grants: without it a remote shard refuses reads and writes once
  its 120-second token expires. A replicated System Store is a separate, later project.
- A lease-guarded Project (one with a standby) refuses remote shards.
- A Project whose remote shard's Agent is unreachable still starts. Tenants on its other shards are served, a Tenant on the
  missing shard is refused with the reason, and anything that spans every shard (Tenant listings, upkeep, images, scatter)
  refuses rather than answer for part of the data. The Project retries the shard every few seconds and reports it as
  not answering until it opens.
- Eligible Tenant reads, including ordinary queries and scatter legs, run on the shard's Node. Similarity and hybrid queries,
  writes, KV and time series remain on the Project's writer. The Agent permits four reads per shard and sixteen per Agent;
  each read has a 10-second deadline and a 32 MiB answer limit, and spends from a work budget: 32 MiB of stored data,
  262,144 entries and 4,194,304 posting identifiers by default (the `shards.readLimits` object of the Agent's config file, `remote-project.json`, changes them; `shards` also takes
  `readsPerShard`, `readsPerAgent`, `readPermitWaitMillis`, `readDeadlineMillis` and `maxReadAnswerBytes`), checked before the
  data is copied. A read that passes its budget is refused whole with HTTP 422 `read-budget-exceeded` (never a partial
  answer, never an unavailable shard and never retried on the writer): narrow it with a filter or a smaller page. A
  collection's unsealed postings each cost an entry, so a very large one is read through its sealed segments once
  maintenance has sealed them. Only SQLite (the Agent's own engine) hosts remote reads. A read's resident memory is a small
  multiple of its byte budget (about 3.6 times in the measurement), so an Agent's worst case is its sixteen concurrent
  reads at that size, which lower `readLimits` and `readsPerAgent` hold down.
- A database image or backup holds every shard's keys and opens as an all-local database.
- A shard that holds a cross-Tenant index's entries cannot be released until the index is dropped or defined on other shards.
- The proof runs a Platform and Project in one container and the Agent in another with the Agent's network cut
  (`pnpm release:qualify:shards`), and in-process through a proxy; a real multi-machine drill is the owner's to run.

### App shard allocation

An operator decides which Nodes a Project's shards may use and the CPU, memory
and disk they share: the Project's *allocation*. Without one, remote shards are
off for the Project. Read the allocation and the ledger with
`GET /zelavis/api/v1/runtime/shard-placement/:projectId` (`fabric.view`) and set
the allocation with `PUT .../shard-placement/:projectId/allocation`
(`fabric.manage`, carrying the generation you observed, `0` for none). A change is
refused with `allocation-in-use` while live shards sit on a Node it removes or
exceed the new budget. The same operations are `client.shardPlacement.get` and
`setAllocation` in the SDK and `zelavis shard-placement get|set-allocation`. This
only records what is allowed; it places nothing by itself.

## Related

- [Project Model](./project-model.md) and [Platform OS and Project Recipes](./platform-project-recipes.md)
- [Execution Backends and Traffic](./execution-backends.md) for how workloads run and how traffic reaches them
- [Zelavis Edge](./edge.md) for ingress
