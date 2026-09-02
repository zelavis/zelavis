---
"zelavis": minor
"@zelavis/ui": minor
---

Standardize **Project recipe** as the create-project term across the runtime,
API, dashboard, and documentation. Project recipes remain services with
`kind: "app"`; a `plugin` extends the Platform or a Project runtime without
being something a Project can be created from.

Rename the recipe discovery endpoint to
`GET /zelavis/api/v1/runtime/project-recipes`, rename project creation input
from `appServiceName` to `recipeName`, and expose the locked Project definition
as `project.recipe` instead of `project.app`. Existing persisted Project records
using the former `app` field are migrated and rewritten on read.
