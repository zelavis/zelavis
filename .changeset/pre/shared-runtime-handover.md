---
"zelavis": patch
"@zelavis/ui": patch
"@zelavis/wordpress": patch
"create-zelavis": patch
---

Share Node Platform and App engine factories, and use Effect scopes to close HTTP before stores during shutdown and failed startup. Add shared Effect admission and handover primitives and a Node supervisor with streaming ingress, exclusive writer transfer, generation checks and rollback, exercised against both actual runtime compositions.

Add immutable recipe snapshots, a scoped kernel-locked journal with flushed release/generation checkpoints, and a Gateway broker that preserves replay protection and queued authorization across worker replacement. Reserve a fresh generation for every update attempt, including aborted drains, and bound the complete readiness probe.

Run native Apps behind a persistent host and allow qualified running recipe upgrades through the existing HTTP, SDK, CLI and dashboard action. Persist an unfinished Project update, freeze the candidate separately, and acknowledge the Platform recipe lock before admission resumes. Failed lock commits roll back; reconciliation settles lost replies from proved host selection. Preserve deletion precedence and re-key surviving Gateway hosts over the Agent pipe.

Seal full engine artifacts including their private Node and dependency-link graph, execute installed App locks through the exact release catalog, and retain qualified engine versions during Platform updates. Stage releases through the same script-disabled npm transport used by installations.

Run the main Platform behind the same persistent host. Dashboard updates prepare an immutable release, drain accepted requests, transfer exclusive store ownership, probe adoption of running Projects, and acknowledge the root-owned receipt, current link and public version descriptor before resuming traffic. Preview listeners share admission and remain bound during transfer and rollback. User installations use the same handover.

Enable the separately supervised Project Agent for every system installation; remove the optional Agent flag. Adopt WordPress daemon handles by exact execution identity and put Linux Unix sockets in shared installation data so the Platform and Agent can use them across separate private temporary directories. Preserve Project placement custody across engine replacement. Unexpected engine exit wakes the host for supervised restart.

Explicit native App recipe upgrades select the latest qualified installed engine. New Apps use that same default, even on an older parent; parent upgrades and rollbacks preserve existing App engine pins. Public older-version selection controls remain planned.

Breaking installation transition: installations without the persistent host and versioned runtime inventory need one full local installer run, which restarts the old process. The live installer refuses unsupported handover protocols; there is no legacy execution shim.

Persist status refreshes under the same Project lifecycle permit as upgrades so a stale read cannot overwrite a recipe lock, update intent or deletion tombstone. Fleet views remain read-only for Fabric scheduling. Keep ordinary Platform startup ready while desired-running Projects reconcile asynchronously; require adoption proof only for engine handover.
