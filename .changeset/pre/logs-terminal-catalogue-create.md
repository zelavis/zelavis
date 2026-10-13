---
"zelavis": patch
"@zelavis/ui": patch
---

The Platform now records the cause behind every "Action failed, Reference: …" message in a bounded, redacted log (and the service journal), read from Server → Logs, `client.logs.read`, `GET /runtime/logs` and `zelavis logs --ref`. Server → Terminal (`client.terminal`, `/runtime/terminal*`, `zelavis terminal`) gives principals with `server.terminal.use` a shell inside tmux as the Platform's unprivileged account, with a fixed `terminal` host package set that installs tmux. A recipe that is only in the Marketplace catalogue is installed before a Project is created from it (the Marketplace and the Projects form do it, and the server refuses otherwise), and the installed package then replaces its catalogue listing, so the Project is locked with the recipe's install methods instead of none. A service installed at runtime stays extension-scoped in the service list once the Platform recomposes, so its dashboard page stays sandboxed and its menus are not offered inside Projects.
