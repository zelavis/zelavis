---
"zelavis": minor
---

Reconciliation now enforces Project placement groups. A Project whose owner
cannot be placed, or whose ownership forms a cycle, is left stopped rather than
started somewhere its group does not permit.

It acts on ownership failures only. Capacity and node eligibility are
scheduling answers, and the local runtime driver does not schedule, so treating
them as refusals would stop Projects on a single-node installation that models
no capacity at all.

A host with no Fabric, a plan containing no owned Projects, and a failing
planner all reconcile exactly as before.
