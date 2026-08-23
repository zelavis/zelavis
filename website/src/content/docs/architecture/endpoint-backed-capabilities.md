---
title: Endpoint-Backed Capabilities
---
Zelavis treats the dashboard as one client of the platform, not as the authority layer.

Everything Zelavis can do should be reachable through a stable server capability and a versioned endpoint. A user should be able to perform the same operation from the dashboard, CLI, AI agent, script, plugin, or external admin tool.

## Rule

Platform behavior starts in the service/runtime layer.

The dashboard may present that behavior, but it must not be the only place that behavior exists.

Required shape:

- define a domain capability behind a service/runtime contract
- expose the capability through the API namespace
- let the dashboard call that endpoint or a typed client for it
- keep privileged behavior out of route components, local React state, and framework-specific server actions

## Examples

Security checklist:

```txt
Capability:
security.runChecklist("linux-hardening")

Endpoint:
POST /zelavis/api/v1/security/checklists/linux-hardening/run

Dashboard:
button -> endpoint/client SDK
```

Resource telemetry:

```txt
Capability:
resources.getHostMetrics()

Endpoint:
GET /zelavis/api/v1/resources/host

Dashboard:
charts -> endpoint/client SDK
```

Domain management:

```txt
Capability:
domains.addDomain(input)

Endpoint:
POST /zelavis/api/v1/domains

Dashboard:
form -> endpoint/client SDK
```

## Why

This keeps Zelavis:

- automatable
- scriptable
- plugin-friendly
- AI-agent-friendly
- usable without the dashboard
- independent from any single UI framework

It also keeps future multi-node and multi-master work cleaner because platform behavior is expressed as explicit capabilities and transportable operations instead of hidden dashboard-only side effects.
