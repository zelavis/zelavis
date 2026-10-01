---
title: Architecture
---
Use this section for cross-cutting platform concepts.

Guideline:

Architecture docs should describe real current behavior and stable design constraints, not speculative product brainstorming. Each page says what is implemented today and what is only planned.

## The platform

- [Project Model](./project-model.md): what a Project is, and the scopes of the dashboard.
- [Platform OS and Project Recipes](./platform-project-recipes.md): the control plane, the Projects it runs, and how a recipe is locked.
- [Recipe Runtimes and Managed Apps](./recipe-runtimes.md): recipes that ship their own runtime, and who may load one.
- [Fabric and Placement](./fabric.md): how a Project is placed on a Node, and what is not operational yet.
- [Execution Backends and Traffic](./execution-backends.md): native and container execution, Kubernetes, and the proxy choice.
- [Zelavis Edge](./edge.md): public ingress and safe proxy switching.
- [Updating Without Downtime](./updates.md): what an update interrupts today, and the plan to make it invisible.

## Services and the marketplace

- [Service Model](./service-model.md): apps, plugins and frontends, and how they load.
- [Marketplace Allow-List](./marketplace-allowlist.md): what an installation may install, and why the list can be fetched from anywhere.
- [Endpoint-Backed Capabilities](./endpoint-backed-capabilities.md): every capability is an endpoint first.

## Access and assistants

- [Access Control](./access-control.md): principals, permissions and scoped grants.
- [Assistant Runtime](./assistant-runtime.md): the Admin Agent, its tools and its limits.

## Dashboard

- [Mobile-Slot-Ready Dashboard](./mobile-slot-ready-dashboard.md)
