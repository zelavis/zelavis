---
"zelavis": patch
---

A WordPress Project created before the recipe-based WordPress (alpha.26) upgrades from the dashboard while it runs: the Platform fetches what the new recipe needs while the site keeps serving, then holds the site's requests for the few seconds it takes to stop the old processes, take its folders over into the new layout (the same files, database, address, password and admin login) and start the new ones. Visitors wait instead of getting an error, and if anything goes wrong the earlier setup is put back and started again. Site previews and a Project's own domains now wait the same way during any such switch, instead of answering that the site is not running.
