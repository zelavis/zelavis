---
"zelavis": patch
---

Recipe updates that move an app to a new layout keep its site answering throughout. Reading a Project while it crossed to a new layout reported it stopped, and that closed its preview listener, so visitors were refused for a few seconds; a crossing Project now stays running to readers and to Edge. Processes a live upgrade starts now run from the new recipe's root, so after the next Platform update they are taken over instead of being started a second time (a duplicate web server, and a PHP-FPM that restarted every 15 seconds). Apps already upgraded by an earlier release are taken over too. A new release gate qualifies these against a server with a history: apps made by old releases, carried by live updates onto the new release, and every recipe upgrade answered without a single failed request.
