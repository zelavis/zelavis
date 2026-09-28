---
"zelavis": minor
---

Route a Project's public paths to its server frontend.

The Gateway now forwards a Project's public surface to its running server
frontend, while `/zelavis/*` stays with the Zelavis runtime that owns the
control plane.

A frontend never receives a Platform authority envelope. The envelope exists so
a Zelavis runtime can enforce the caller's permissions; a frontend is
third-party application code, and handing it a signed claim about a Platform
principal would give arbitrary code Platform authority.

A frontend that is not yet running, or an ownership lookup that fails, falls
back to the Project's own runtime rather than taking the site down.
