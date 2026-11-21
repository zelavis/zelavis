---
"zelavis": patch
---

Prevent intermittent HTTP 502 responses during live Platform updates and speed up App upgrades and rollbacks by disabling loopback keep-alive socket pooling on private host-to-worker/site fetches and moving full release artifact verification off the main event loop.
