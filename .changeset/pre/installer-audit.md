---
"zelavis": patch
"create-zelavis": patch
---

Refuse `install --stage-only --dry-run` before release preparation and correct installer guidance for default Traefik ingress and private management listeners.

Correct Debian package removal to inspect its lifecycle argument and stop the Platform, ingress, dashboard socket and updater activation. Management requests can no longer restart the removed Platform. The removal hook leaves running services alone during package upgrades.
