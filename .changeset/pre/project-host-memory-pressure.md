---
"zelavis": patch
---

Installed Project hosts use less memory. They verify each selected engine in a short-lived process and keep supervising the engine after verification finishes. On systemd installations, the OOM scores favor reclaiming memory from Project processes first, and the Project Agent continues supervising other Projects after a child is killed. Live updates apply the refreshed scores to running services.
