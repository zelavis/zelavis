---
"zelavis": minor
---

Let a Tenant too large for one shard be divided into parts.

A Tenant is the locality unit, and everything belonging to one living on one
shard is what makes a cross-model query a local intersection rather than a
network exchange. A Tenant that does not fit on a shard is the one case that
bargain cannot be kept, and until now there was nothing to do about it:
`AGENTS.md` promised that exceptional Tenants would eventually scale Shards, but
no code did.

`topology.subdivision.subdivide(tenant, parts)` declares a Tenant divided.
`db.forPart(tenant, part)` reaches one part, and `db.forTenant` now **refuses** a
divided Tenant rather than handing back one part — answering a question about a
fraction as though it were about the whole is precisely the quiet wrong answer
this design exists to avoid. A question about the whole Tenant is a `scatter`
over `topology.subdivision.keysOf(tenant)`, which is explicit and reports what it
cost.

Below routing a part is simply a Tenant. Tenancy here is structural — part of
every namespace and lens key — so a part with a compound key gets the same
isolation, the same dense identifier space and the same local intersection
*within itself* from machinery that already existed. Storage, lenses, movement,
scatter and backup needed no changes; only routing and a registry are new.

Dividing is a routing decision and carries no data, so it is refused for a
Tenant that already holds records, for the same reason `topology.update` refuses
an occupied range: the records would stay under the undivided key while reads
went to parts that do not hold them. Re-keying an occupied Tenant into parts is
a migration rather than a routing change, and is not part of this.

Atomicity now stops at one partition rather than one Tenant. For every undivided
Tenant — which is nearly all of them — the partition is the Tenant and nothing
changes. `AGENTS.md` is updated to match.
