---
"zelavis": patch
---

Project authority now carries into the Project's own runtime services. A
Project runs its own workloads, storage, and database services, and each
enforces its own permissions — but nothing mapped Platform Project permissions
onto them, so an owner holding full authority arrived inside their own Project
with none of them and those screens returned 403.

Viewing a Project implies seeing what runs in it; managing its runtime implies
changing what runs in it. Destructive operations stay behind runtime
management rather than riding along with view, and the forwarded envelope is
still a named list rather than a wildcard.
