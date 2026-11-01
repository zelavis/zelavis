# Merging a Tenant branch back: conflict model

Review date: 2026-10-30. Decided 2026-10-31 (the owner delegated the decision)
and implemented in `src/db/branch-merge.ts` (`db.mergeBranch`, HTTP
`tenants/:id/merge`, SDK `mergeTenantBranch`, CLI `merge-branch`, dashboard
"Merge back"). Where the implementation settled the open points, see
"As built" at the end.

## What a merge is, and is not

A branch (`db.branchTenant`) and its source share one log up to the branch
point recorded in the branch's lineage, then diverge. A merge applies what the
branch changed after that point to the source, through the source's own
documents API and writer. It is never a raw-key copy, never touches the
branch, and never makes the two partitions one: the branch stays a Tenant of
its own afterwards.

It is a three-way comparison per record, with the branch point as the common
ancestor. The positions are the shared log's, so "changed after the branch
point" is exact on both sides: a record's version at the branch point is the
same in both partitions, and any later event for it is a change on that side.

## Per-record outcomes

| Source since branch point | Branch since branch point | Outcome |
|---|---|---|
| unchanged | unchanged | nothing |
| changed | unchanged | nothing (the source keeps its own) |
| unchanged | written or removed | apply the branch's current state to the source, with the branch-point version as `expectedVersion` |
| changed | changed to the same state | nothing |
| changed | changed differently | conflict |
| removed | changed | conflict |
| changed | removed | conflict |

There is no default winner. Last-writer-wins, field-level merging and CRDT
policies are refused for the same reasons as in
[offline-replication-decision.md](offline-replication-decision.md): they make
a clock or a merge function part of data authority and can break unique,
check and reference constraints without telling anyone.

A conflict is resolved only by the caller naming, per record, which side to
keep (`keep: "source" | "branch"`). A merge with any unresolved conflict
applies nothing and returns the full conflict list; that dry run is the first
step of every merge.

## Definitions and derived state

- Collection definitions (columns, analyzer, measures, edges, indexes, checks,
  references) and schema versions are compared the same way. A definition the
  branch added is created in the source; one changed on both sides, or changed
  in the branch where the source still holds records it would refuse, is a
  conflict. Definitions are applied before records.
- Every applied record goes through the source's checks, uniqueness and
  references inside its own transaction. A refusal there stops the merge with
  that record named; it is never skipped.
- Projections, time series and cross-Tenant indexes are derived: they follow
  the source's log, so a merge writes no checkpoint and copies no derived state.
- KV keys follow the record rules. Outbox messages are not merged: they are the
  delivering Tenant's, and a message the branch emitted is delivered by the
  branch's consumer if anyone's.

## Atomicity, resumption and authority

A merge spans many source transactions, so it is a workflow, not one write.
Each applied record carries the idempotency key
`merge:<branch>@<branch point>:<record>:<branch version>`, so a merge cut off
and run again repeats nothing, and a merge whose plan is recomputed after a
partial run recognizes its own earlier writes by those receipts rather than
reading them as source-side changes (that would turn every applied record into
a conflict). Progress is a durable intent in the source, like a schema
activation, so the database resumes or reports it at open.

A merge needs `database.define` (it can create definitions) and
`database.write` on the source, and `database.read` on the branch. It is
refused for a divided Tenant unless both sides are divided the same way, and
then it is a merge per part, each consistent within itself only, as branching
is.

## Open questions for approval

- Whether a record removed on one side and unchanged on the other should merge
  the removal (proposed: yes, as a write).
- Whether merges may be scheduled from the dashboard or only run on request
  (proposed: on request only, with the dry run shown first).

## As built (2026-10-31)

- Removals merge as writes: a document only the branch removed is removed in
  the source (checked against the version read).
- On request only, with the dry run first; the dashboard plans, shows the
  conflicts and asks which side to keep for them.
- Resumption needs no durable intent: a merge is repeatable by state. A
  document already carrying the branch's state is "the same on both sides"
  and is left, so a merge cut off part way is simply run again. Each batch is
  checked against the versions the plan read, so a source written meanwhile
  refuses the batch (`DocumentConflict`) and the merge is run again.
- Definitions: a collection the branch created is created in the source.
  A definition changed on an existing collection is a conflict settled only by
  keeping the source's definition; applying definition changes is not done.
- Key-value entries are documents and merge as documents. Outbox messages and
  schema versions are not merged and are listed in `unmerged`; idempotency
  receipts, checkpoints and series state are derived and ignored.
- At most 200,000 changed documents per merge.

