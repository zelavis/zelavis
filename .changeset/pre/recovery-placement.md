---
"zelavis": patch
---

A recipe update that failed with "Update recovery required" is now recovered when the Platform reconciles, such as after **Update now**. Before, the recovery restarted the app's previous processes without the Project's placement, so the Agent refused them again and the Project stayed stuck. The app then runs on its previous recipe and can be updated again.
