# celld Evaluation

Reviewed: 2026-09-10 against `denoland/celld` v0.4.1 (`10cb130`, released 2026-09-05).

Status: architecture evaluation for roadmap item P0-b. The one idea adopted now, probing an object store's conditional-write guarantees instead of trusting its label, ships in the same change as this document. Nothing else in Zelavis changes.

## Scope

This evaluation reads celld's documented protocol (`docs/guarantees.md`, `limitations.md`, `security.md`, `testing.md`) and checks its central claims against the source: `crates/celld/bucket.rs`, `ownership_store.rs`, `actor.rs`, `wake.rs`, `pool.rs` and `js/r2_ops.rs`, `crates/logic` and `crates/ltx`. It compares each mechanism with what Zelavis does today, citing code, and decides how Zelavis should relate to celld.

It does not run celld. A fleet needs a bucket with conditional writes, and the numbers below are celld's own published measurements, marked as such. Reproducing them is listed at the end as a follow-up.

## What celld is

celld is a Rust daemon, about 100k lines, that runs a Cloudflare Workers application on your own machines: Workers, Durable Objects, KV, Queues, D1, R2, Workflows, Cron Triggers and static assets, deployed from an existing `wrangler.json`. Each Durable Object is a **cell**: a named server with its own SQLite database. The nodes that share one bucket form a **fleet**, and that bucket (S3-compatible, Google Cloud Storage or Azure Blob) holds the deployments, the cell state and small ownership records. There is no control plane, membership protocol or consensus service. A conditional bucket write decides which node owns a cell.

- **Maturity:** by its own description it's an alpha. Its first public release was 2026-08-02, and there have been eight releases in five weeks (v0.0.1 to v0.4.1); the public history is squashed to 8 commits. The repository has 4.6k stars and 14 open issues.
- **License and platforms:** it's Apache-2.0, and binaries ship for Linux x86-64, Linux ARM64 and Apple Silicon. Windows isn't supported.
- **Scope:** one fleet runs one application. celld has no account service, no multi-tenant scheduler and no managed ingress (`limitations.md`).

## Recommendation

1. **Use celld as a reference now.** Its storage and ownership mechanisms are small, precise and tested under adversarial schedules. Four of them fill gaps Zelavis has documented but not closed (see "What to adopt").
2. **It could become a Project runtime backend later, not now.** A Workers-compatible Project could run on a celld fleet behind `src/backends/`, one fleet per Project: Fabric places the celld nodes as the Project's bounded allocation, and celld places cells within it. This is the same layering the App Data Fabric already has inside a Project envelope. It waits until celld leaves alpha and a prototype passes the conditions under "Integration options".
3. **Don't integrate it as a Zelavis scheduler, a storage engine, or the public object-storage contract.** Its ownership model would compete with Fabric's, its SQLite-per-cell topology would fork Zelavis's source of truth, and its R2 surface is Cloudflare's shape, not Zelavis's.

## How celld keeps its two promises

celld promises that exactly one node serves a cell at a time, and that no acknowledged write is lost. Both rest on the bucket.

**The bucket must provide four properties:** a conditional create, a conditional overwrite, read-after-write consistency, and ranged reads. No provider documents these reliably, so every node tests them before it serves (`bucket.rs`, `probe_cas_steps` / `cas_contract`), all against one fresh key:

1. A create of an absent object must apply and return its etag.
2. A second create must be **rejected**.
3. An update carrying the current etag must apply.
4. An update carrying the now-stale etag must be **rejected**.

Steps 2 and 4 are the fence. A store that accepts the `If-None-Match` / `If-Match` headers and ignores them fails here, instead of later with two owners. An error where a clean rejection was required also counts as a failure, because an ambiguous answer can't distinguish a lost race from a failed write. Amazon S3, Cloudflare R2, Tigris, GCS and Azure are qualified. Backblaze B2, Hetzner Object Storage and DigitalOcean Spaces don't implement the conditions. MinIO passes the probe but isn't qualified for production.

**Ownership record.** Ownership is `cells/<cell>/own.json` = `{node, epoch}` (`ownership_store.rs`). A node acquires a cell by creating the record, or by a compare-and-swap on the previous record's etag. Every activation advances the epoch (`crates/logic/lib.rs`, `record.epoch.saturating_add(1)` under `CasGuard::Match(etag)`), so an epoch never has two writers.

**Epoch in the key.** Replicated SQLite data is written with plain PUTs under `cells/<cell>/ltx/e<epoch>/`. A node that has lost the cell can keep writing, but only into a superseded prefix, and a restore follows the current epoch chain.

**Acknowledgement gate (RPO 0).** A response, including an error or a streamed chunk that could reveal a written value, is held until a durability proof covers the write. There are two kinds of proof:
- **Bucket proof:** the write is uploaded, then the ownership record is re-read to confirm this node still owns the cell at this epoch. That re-read compares records, not clocks, so a paused or clock-skewed node can't pass it.
- **Fleet proof:** one or two follower nodes fsync the write.

A single node has no followers, so it always waits for the bucket.

**Takeover recovery gate.** Each process session creates a conditional node-log record before its first fleet-acknowledged write. A cold activation checks the prior owner's record. If it's open, the activation fences it, seals the reachable followers, uploads their retained writes, and only then restores.

**Self-fencing.** Each node holds a lease in the bucket, renewed every third of its lifetime (`CELLD_TTL_MS`, 10 s; `actor.rs`). When the published expiry passes without a renewal, or the record is missing or no longer matches this process, the node stops every cell, fails its in-flight requests and exits with code 3 (`SELF-FENCE:`). A supervisor must restart it, without an attempt limit and at least one lease lifetime apart.

**Hibernation.** An idle cell is evicted after `CELLD_IDLE_EVICT_S`, or earlier under memory pressure (`logic/pressure.rs`). An alarm-bearing cell leaves a durable wake hint at `wake/<YYYY-MM-DDTHH:MM>/<cell>` (`wake.rs`), so the alarm survives a crash, a fence or a deploy. A cold activation restores from the bucket, paging the database in on first touch. Balancing moves only hibernated cells, at most 32 per five-second sample, as one record write each.

**R2.** R2 is served from the fleet bucket under `r2/<bucket>/` (`js/r2_ops.rs`), with an object's version equal to its content etag, and the R2 index is itself a cell. It adds no second storage service.

**Stateless Worker pool.** A shared V8 isolate pool runs on one multi-threaded Tokio runtime (`pool.rs`). Isolates belong to no thread, and admission is gated so no Tokio worker ever blocks on V8.

## Concept map

| celld | Zelavis today | Gap, or what to take |
|---|---|---|
| Cell identity: a named Durable Object, `Class:ID` | Tenant (logical), partition key and shard (physical), Project (hosting) | celld's cell sits between Zelavis's Tenant and shard. It has a single owner and its own database, but no cross-cell query. Nothing to adopt. |
| Owner lease: a node lease with published expiry, renewed every TTL/3, self-fence on loss | Agent operation leases are `{ownerId, expiresAt}` compared with the local clock (`src/agent/operation-journal.ts`). There's no self-fence, and a stale holder isn't fenced out of side effects. | **Adopt:** an Agent should stop acting when its published lease can't be renewed, and each side effect should carry a fencing token the target checks. |
| Fencing epoch: in `own.json`, advanced by CAS on every activation | Writer generations are claimed per partition and re-read inside every write transaction (`src/db/kv-store.ts`, `claimGeneration` / `assertCurrent`; app SQLite fencing per `TODO.md`). Fabric placement generations are fixed projections that "cannot fence stale owners" (`ARCHITECTURE.md`, Placement authority). | The data-plane fence exists and matches celld's in effect. **Adopt the model** for the control plane: when placements move into System Store contracts, make them `{owner, epoch}` records acquired by compare-and-swap, like `own.json`. |
| Epoch in the object key for replicated data | There's no object replication. Replication is the event log (`events.apply`), and replica plans aren't executed yet (`TODO.md`). | **Adopt when backups or replicas go to object storage:** a writer's epoch in the key, so a stale writer can only write where no restore looks. |
| Acknowledgement gate: RPO 0 | A commit returns after the local WAL write, not an fsync. A dead process loses nothing; a power cut can lose a suffix (`test/db-durability.test.mjs`). | A different, stated trade-off. **Consider** gating acknowledgements on a follower fsync once replicas execute. Don't claim RPO 0 before then. |
| Bucket durability proof: upload, then re-read ownership | None | The re-read is the part worth keeping: authority confirmed by a record, not a clock. |
| Takeover recovery gate: node-log records sealed before restore | `db.movement` fences writes for the final catch-up and moves routing (`ARCHITECTURE.md`). Local move, split and merge aren't durable state machines yet (`TODO.md`). | **Adopt the rule:** the successor seals the predecessor's session before serving. Movement already fences; persisting it is the open item. |
| Hibernation, plus a durable wake hint | Projects are running or stopped. There's no scale-to-zero. | **Consider for Projects:** a durable wake record kept outside the runtime, so an idle Project costs nothing and still wakes for a schedule. |
| R2: a binding over the fleet bucket, the index as a cell | `ZelavisFileStorage`: local filesystem and S3 (`src/storage/s3.ts`), behind Zelavis's own interface | **Don't expose it.** If Zelavis ever serves an R2-shaped API, map it onto `ZelavisFileStorage`, never the reverse (roadmap). |
| Stateless Worker pool: V8 isolates | Project runtimes are processes (a Node child, Docker later) chosen by a backend driver (`src/backends/registry.ts`) | A celld fleet would be one such driver, not a replacement for the Agent. |
| Scheduler: a fleet-local balancer and pressure shedding | The Platform Fabric is the only placement authority; Agents execute (`AGENTS.md`) | **The integration boundary:** celld may place cells, never Projects or Nodes. |
| Storage guarantee probe | S3 storage sends no conditional headers (`src/storage/s3.ts` has only get, put, delete and list) | **Adopted in this change.** |

## Topology: SQLite and LTX per cell, against event-sourced shards

celld's unit is a cell with one SQLite database, replicated page-wise as LTX to the bucket. Zelavis's unit is a partition in an event-sourced store: one payload projected through document, column, measure and graph lenses; many partitions per physical shard; the event log as the source of truth and the replication stream; shards placed through a versioned map. The two answer different questions:

- celld makes one object's state highly available with no coordinator. Nothing spans cells, except through RPC between them.
- Zelavis makes a Tenant's data queryable across data models in one intersection, and moves whole ranges between shards.

Running Zelavis's store inside celld cells would give up the cross-model intersection and the partition map. Running celld's model inside Zelavis would duplicate the source of truth. Neither should replace the other (roadmap). What transfers is the storage protocol, not the data model.

## Integration options

| Option | Verdict |
|---|---|
| Reference and inspiration | **Yes, now.** See "What to adopt". |
| Deployment or runtime backend | **Later, conditionally.** It fits as `src/backends/celld`, a `projectRuntime` driver for Workers-compatible Projects. The conditions for a prototype: (1) Fabric places and moves celld nodes as the Project's allocation, and celld never places anything outside it; (2) one fleet and one bucket credential per Project, since a bucket credential controls a whole fleet (`security.md`); (3) the Zelavis Gateway terminates TLS, and peer traffic (plaintext HTTP with HMAC) stays on a private network or an encrypted overlay; (4) an Agent supervises the process under celld's restart rules; (5) no celld or Cloudflare type appears in a public Zelavis contract; (6) celld has left alpha. |
| External compatible service | **No added value.** celld's R2 is its own bucket under a prefix, so Zelavis should talk to the bucket through `ZelavisFileStorage` instead of through celld. |
| Storage engine (`KvEngine`) | **No.** celld isn't an ordered key-value engine, and embedding its cells as shards forks the source of truth. |
| Platform scheduler | **No.** It would be a second placement authority whose ownership can disagree with Fabric's, which `AGENTS.md` rules out. |

## Operational characteristics

These are celld's published numbers (`testing.md`), measured by celld and not reproduced here.

| | celld |
|---|---|
| RPO | 0 for acknowledged writes, through the acknowledgement gate. |
| Write latency | About 25 ms with a fleet proof and about 600 ms with a bucket proof (lab fleet). A single node always pays the bucket proof. Concurrent writes to one cell share one upload. |
| Warm request | p50 about 1.1 ms, p99 about 7 ms, with zero bucket operations. |
| Cold activation | A restore from the bucket. A paged restore opens over a sparse file and fetches pages on first touch. There's no published number yet for the current replicator. |
| Recovery | With two of ten nodes stopped (4 vCPU, 8 GB each; 10k resident cells; 20k WebSockets), every cell's data was available again within about 11 s at the tail, given reserve headroom. Without headroom it degrades. |
| Fencing | 500 concurrent claimants, 5,500 attempts, one writer per epoch, zero violations. |
| Egress and request cost | Every committed write reaches the bucket, and cold activations read from it. On S3 that's per-request and egress charges; R2 has no egress fee. Budget for this before a prototype. |
| Provider compatibility | S3, R2, Tigris, GCS and Azure are qualified. B2, Hetzner and DigitalOcean Spaces are incorrect for celld. MinIO passes the probe but is unqualified, and one release was broken (#162). |
| Credential authority | The bucket credential is the fleet's root authority: deployments, state and the peer secret. |
| Supervision | A restart without an attempt limit, spaced at least one lease lifetime. Self-fence exits with code 3. |
| Security | No TLS; peer HTTP is plaintext with an HMAC; application code is trusted; one tenant per fleet. |

## What this evaluation found in Zelavis

1. **Object storage accepted any "S3-compatible" label.** `createS3CompatibleFileStorage` could not express a conditional write, so nothing could detect a store that ignores one. *Addressed in this change:* conditional create and overwrite in the file-storage contract, and a probe that checks them.
2. **The file-backed service registry is last-writer-wins.** `createFileStorageServiceRegistryStore` (`src/platform/settings.ts`) rewrites the whole registry with an unconditional PUT. It's the fallback when a Platform has file storage but no System Store or KV (`src/index.ts`). Two Platforms sharing that storage would silently drop each other's updates. *Open:* read with an etag and write with `ifMatch`, retrying on a conflict.
3. **Fabric placement generations can't fence.** This is already recorded in `ARCHITECTURE.md`. celld's `own.json` is a working model for the authoritative record: `{owner, epoch}` acquired by compare-and-swap, with the epoch advanced on every activation.
4. **Agent leases trust the local clock and don't self-fence.** An Agent that can't renew keeps acting until something else notices. celld's rule is to fence at the published expiry and to fence at once on a missing or foreign record.
5. **Durability is a stated trade-off, not RPO 0.** That's correct as documented. Replication must not be advertised as closing it until acknowledgements wait for a follower.

## Checklist

- [x] Map celld's concepts against Fabric, Project runtimes, Agents, shard placement, fencing and replication (this document).
- [x] Decide the posture: a reference now; a conditional Project runtime backend later; no scheduler, engine or public contract.
- [x] Add conditional create and conditional overwrite to `ZelavisFileStorage`, implemented for the S3 and local backends.
- [x] Add a guarantee probe that runs celld's four steps plus read-after-write, and refuses a store that accepts a condition without enforcing it.
- [ ] Require the probe before any object backend is used for leases, fencing or authoritative publication.
- [ ] Make the file-backed service registry write conditionally.
- [ ] Model authoritative placements as `{owner, epoch}` compare-and-swap records when they move into the System Store.
- [ ] Self-fence Agents on an unrenewed lease, and carry a fencing token into their side effects.
- [ ] Reproduce celld's latency, cold-activation and recovery numbers against MinIO and one qualified provider before any prototype.
- [ ] Re-evaluate the runtime-backend option when celld leaves alpha.
