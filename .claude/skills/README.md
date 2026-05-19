# Claude Skills

This folder contains tracked Claude-compatible skills for working in the
Zelavis repository.

Current skills:

- `zelavis-core-platform`: core package architecture, service boundaries,
  adapters vs plugins, and runtime-neutral design.
- `zelavis-dashboard-ui`: dashboard routing, `/zelavis`-mounted dev flow,
  sidebar/navigation work, and embedded UI integration.
- `zelavis-repo-maintainer`: GitHub workflows, community files, labels,
  security workflow, and contributor-facing repo maintenance.
- `zelavis-release-maintainer`: Changesets, versioning, publish flow, and
  release hygiene for workspace packages.

Local Claude worktrees, caches, and machine-specific state are intentionally
ignored by the repository root `.gitignore`.
