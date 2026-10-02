---
"zelavis": patch
---

Updates no longer interrupt the dashboard. systemd holds each instance's port in a socket unit, an update prepares the new release while the old one keeps serving and then swaps once, so connections queue instead of being refused (no failed requests in a test that probed every 50 ms). Named instances update from their own dashboard, and user-mode installs (macOS, Linux without systemd) update by selecting the new release and asking for a restart. Run the installer once to add the socket; every update after that is live.
