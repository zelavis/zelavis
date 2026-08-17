# @zelavis/workloads

First-party Zelavis Workloads service for project-scoped functions, jobs,
schedules, and webhooks.

This package is a core plugin: officially maintained and designed to feel native
inside Zelavis, but still separate from the base runtime so execution adapters
can evolve independently.

The first implementation provides:

- in-memory workload registry
- HTTP endpoints for list, create, update, read, run, logs, and dashboard menus
- dashboard menu metadata with dynamic sections for functions, jobs, schedules,
  and webhooks
- trusted local JavaScript execution for function workloads
- explicit namespaced HTTP function testing at
  `/api/v1/workloads/http/:projectId/*path`

The local JavaScript runner is intentionally trusted-development only. It
imports and executes saved JavaScript in the current Zelavis runtime process. It
does not provide sandbox guarantees, resource limits, tenant isolation, or
production execution hardening yet.

Production isolation, durable queues, schedules, public route binding, and
external provider sync belong behind future runner/provider adapters.
