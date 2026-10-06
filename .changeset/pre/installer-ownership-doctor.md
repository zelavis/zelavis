---
"zelavis": minor
"create-zelavis": patch
---

Add host-local installation ownership guards and read-only `zelavis doctor`. Install/removal are serialized by a kernel-released installer lock; Node/Bun Platform startup and maintenance share one data guard. Current receipts record source, entry, mode, instance, version and paths, and package/create installs use the same receipt-owned removal inventory. Foreign layouts, live data owners and occupied port 3000 are refused; force only permits command replacement. Old pre-release receipt shapes are refused without migration.

Create forwards the invoking PATH only for conflict inspection while privileged bootstrap commands retain a fixed trusted PATH. Doctor reports installation, service, port and Agent host-feature state without changing files or taking locks. System repair/upgrade can stop and restart a matching owned Platform; zero-downtime updates and named instances remain planned.
