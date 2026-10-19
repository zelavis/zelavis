# @zelavis/ui

## 1.1.0-alpha.41

### Patch Changes

- Updated dependencies [e3cd867]
  - zelavis@2.0.0-alpha.41

## 1.1.0-alpha.40

### Patch Changes

- Updated dependencies [d07cc80]
  - zelavis@2.0.0-alpha.40

## 1.1.0-alpha.39

### Patch Changes

- c038a76: The terminal fills its window: it was fitted to nine columns because the island holding it was an inline element, which also made typed text hard to follow. API keys are now a section of Server → Access with presets (Debug read-only, Operator, Project client), one-time display, rotation and revocation. A new read-only diagnostic, `zelavis debug processes` (`client.debug.processes`, `GET /runtime/debug/processes`, permission `server.debug.read`), lists the Platform account's Zelavis processes with secrets removed and flags a command running more than once side by side.
- Updated dependencies [c038a76]
- Updated dependencies [84b8e68]
- Updated dependencies [5745c67]
  - zelavis@2.0.0-alpha.39

## 1.1.0-alpha.38

### Patch Changes

- Updated dependencies [acf44d8]
- Updated dependencies [c8c7ff0]
  - zelavis@2.0.0-alpha.38

## 1.1.0-alpha.37

### Minor Changes

- 659cb13: The dashboard is now built with Fuzor. It is the same dashboard to use: every page is there and every page is now native: the Database workspace uses three grid libraries with draft recovery, Content Studio, Workloads, Storage and Media, the Marketplaces, Server and Fabric, the Assistant, Settings and the first-run setup were rebuilt, and **Update now** is in the shell on every page. Uploads from the dashboard keep their label, alt text and purpose (the Gateway removed them before). One build now mounts at any root path (`/zelavis`, `/admin`, `/`), the dashboard calls the Platform it runs in directly rather than over a guessed address, and the package ships only built output that needs nothing installed beside it. The previous React dashboard stays in the repository as `@zelavis/ui-legacy`, private and no longer shipped. Development uses the Fuzor checkout next to the repository when there is one, and the pinned npm release otherwise.

### Patch Changes

- Updated dependencies [3548515]
- Updated dependencies [659cb13]
- Updated dependencies [16739cd]
  - zelavis@2.0.0-alpha.37
