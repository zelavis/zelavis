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

- **Remote shard movement.** The Platform places whole Projects. Moving parts of
  an App's database to another Node needs durable owner-and-epoch authority,
  destination fencing and publication ordering that are not built. The request
  contract exists as an internal reservation, and a reservation is neither a
  writer grant nor a route.
- **Project Cells.** A Project that manages nested Apps inside its own allocation
  is a design direction. The parent would place the whole cell as one group and
  keep provider and Node authority.
- **Distributed drivers.** Leases and fencing, durable work queues,
  health-based placement and paginated Project discovery are needed before a
  multi-host scheduler. The in-process child map must not be stretched into one.

## Related

- [Project Model](./project-model.md) and [Platform OS and Project Recipes](./platform-project-recipes.md)
- [Execution Backends and Traffic](./execution-backends.md) for how workloads run and how traffic reaches them
- [Zelavis Edge](./edge.md) for ingress
