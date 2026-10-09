---
"zelavis": patch
"@zelavis/wordpress": patch
---

WordPress is now a recipe (`defineRecipe` install and start phases) run by the Platform's recipe runtime instead of a hand-written runtime module. Phases run in their own process under Node's permission model, the process plan is supervised and adopted after a restart, and the WordPress release is pinned in the recipe's `zelavis.project.install` manifest. A stopped WordPress Project made by an earlier version upgrades to it from the Upgrade action: its folders are renamed into the new layout and its ports, database password and socket identity are carried over, so its address, content, uploads and admin login stay as they were (the move is journaled and is reversed if anything fails). New Projects use the new layout.

A running Project made from a recipe with a process plan now upgrades to a newer recipe without stopping: the new plan is reconciled against the running processes, unchanged ones keep serving, configuration-only changes reload in place and only changed processes are replaced in dependency order, with a durable journal and rollback to the previous plan on any failure.
