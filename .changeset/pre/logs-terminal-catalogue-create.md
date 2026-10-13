---
"zelavis": patch
"@zelavis/ui": patch
---

The Platform now records the cause behind every "Action failed, Reference: …" message in a bounded, redacted log (and the service journal), read from Server → Logs, `client.logs.read`, `GET /runtime/logs` and `zelavis logs --ref`. Server → Terminal (`client.terminal`, `/runtime/terminal*`, `zelavis terminal`) gives principals with `server.terminal.use` a shell inside tmux as the Platform's unprivileged account, with a fixed `terminal` host package set that installs tmux. A recipe that is only in the Marketplace catalogue is installed before a Project is created from it (the Projects form does it, and the server refuses otherwise), instead of creating a Project with no install methods.
