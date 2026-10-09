---
"zelavis": patch
"@zelavis/wordpress": patch
---

WordPress is now a recipe (`defineRecipe` install and start phases) run by the Platform's recipe runtime instead of a hand-written runtime module. Phases run in their own process under Node's permission model, the process plan is supervised and adopted after a restart, and the WordPress release is pinned in the recipe's `zelavis.project.install` manifest. New WordPress Projects use the new layout; existing Projects keep the recipe they froze.
