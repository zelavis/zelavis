---
"zelavis": minor
---

Make Fabric placement decide where a Project runs.

Reconciliation reads the placement plan's assignments, not only its refusals. A
Project the planner placed on another node is no longer started on this host,
and one already running here when it moves away is stopped — running it anyway
would contradict the Fabric, and on a fleet where every host reconciles, every
host would reach the same conclusion and run its own copy. An explicit `start`
is refused for the same reason, naming the node.

`ZelavisProjectDispatcher` is the seam for handing such a Project to the node
that owns it; without one, the Project is left stopped with the node recorded
on the Project record, so "why is this not running" has an answer that survives
the next runtime status poll. The Fabric's placement inventory now reports that
node rather than asserting everything is local.

Unchanged for a single-node installation: a host that does not know which node
it is, and a planner that fails, both start everything locally as before.
