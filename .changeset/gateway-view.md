---
"zelavis": patch
---

Requests to a Project keep flowing while its Zelavis version is switched or its recipe is updated live: the Platform routes them with a view of the Project that does not wait for the operation, so they pause only for the moment the engine is handed over instead of for the whole switch (which could exceed 30 seconds).
