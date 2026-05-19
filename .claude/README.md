# Claude Workspace Files

This repository ships a small tracked `.claude/` folder for Claude-compatible
tooling and contributor guidance.

## What belongs here

- lightweight repo-specific guidance files
- shareable Claude workflow notes
- small tracked configuration that is safe for all contributors

## What does not belong here

- local worktrees
- nested Git repositories
- dependencies or build output
- machine-specific secrets or caches

The main source of truth for repository behavior and architecture is still
[`AGENTS.md`](../AGENTS.md). Contributor workflow and security process are
documented in:

- [`README.md`](../README.md)
- [`CONTRIBUTING.md`](../CONTRIBUTING.md)
- [`SECURITY.md`](../SECURITY.md)

Local Claude state under `.claude/` is intentionally ignored unless it is
explicitly whitelisted in `.claude/.gitignore`.
