---
"zelavis": patch
---

Requests to a Project keep flowing while its Zelavis version is switched or its recipe is updated live: the Platform finds and reaches the Project without waiting for the operation (a managed app's integration runtime aside), so they pause only for the moment the engine is handed over instead of for the whole switch (which could exceed 30 seconds).
