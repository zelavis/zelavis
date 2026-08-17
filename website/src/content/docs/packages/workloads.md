---
title: "@zelavis/workloads"
---
`@zelavis/workloads` is the first-party core plugin for project-scoped
functions, jobs, schedules, webhooks, logs, and workload settings.

It is enabled by the high-level `zelavis` runtime by default, but remains a
separate package so runner and provider adapters can evolve independently from
the base runtime.

## Implemented Today

- in-memory workload registry
- service-owned dashboard menu metadata
- dynamic menu sections for functions, jobs, schedules, and webhooks
- create, read, update, run, list, menu, and logs endpoints
- trusted local JavaScript execution for function workloads
- explicit namespaced HTTP function testing:

```txt
/zelavis/api/v1/workloads/http/:projectId/*path
```

The built-in starter function currently uses project `default` and route
`/api/hello`, so the local development test URL is:

```txt
/zelavis/api/v1/workloads/http/default/api/hello
```

## Current Limits

The JavaScript runner is trusted-development only. It imports and executes saved
JavaScript in the current Zelavis runtime process.

It does not yet provide:

- sandbox guarantees
- CPU or memory limits
- tenant isolation
- durable queues
- production scheduling
- public route binding such as `/api/hello`

Those belong behind future runner/provider adapters.

## Future Adapter Direction

Future workload runners should be explicit adapters with capability detection.
For example, a host may support worker threads, subprocess runners, containers,
workerd, or microVM-backed isolation, but those choices depend on runtime,
binary availability, operating system support, and host permissions. They should
not become hidden assumptions in the core runtime.

External providers may sync or deploy workloads through optional plugins, but
the default ownership model remains the long-running self-hosted Zelavis server.

## Related Docs

- [Service Authoring](../guides/service-authoring.md)
- [Service Model](../architecture/service-model.md)
- [Runtime Targets](../reference/runtime-targets.md)
- [Route Conventions](../reference/route-conventions.md)
