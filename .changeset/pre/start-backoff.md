---
"zelavis": patch
---

A Project that keeps failing to start is no longer prepared and failed again every 15 seconds: automatic starts back off after each failure (15 seconds, doubling, up to an hour), its failure reason stays on the Project, and starting, stopping, updating, upgrading or deleting it tries again at once.
