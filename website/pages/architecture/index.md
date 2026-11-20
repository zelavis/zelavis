---
layout: docs
title: "Architecture"
---

# Architecture

Use this section for cross-cutting platform concepts.

Guideline:

Architecture docs should describe real current behavior and stable design constraints, not speculative product brainstorming. Each page says what is implemented today and what is only planned.

## The platform

- [Project Model](/architecture/project-model/): what a Project is, and the scopes of the dashboard.
- [Platform OS and Project Recipes](/architecture/platform-project-recipes/): the control plane, the Projects it runs, and how a recipe is locked.
- [Recipe Runtimes and Managed Apps](/architecture/recipe-runtimes/): recipes that ship their own runtime, and who may load one.
- [Fabric and Placement](/architecture/fabric/): how a Project is placed on a Node, and what is not operational yet.
- [Execution Backends and Traffic](/architecture/execution-backends/): native and container execution, Kubernetes, and the proxy choice.
- [Zelavis Edge](/architecture/edge/): public ingress and safe proxy switching.
- [Updating Without Downtime](/architecture/updates/): what an update interrupts today, and the plan to make it invisible.

## Services and the marketplace

- [Service Model](/architecture/service-model/): apps, plugins and frontends, and how they load.
- [Marketplace Allow-List](/architecture/marketplace-allowlist/): what an installation may install, and why the list can be fetched from anywhere.
- [Endpoint-Backed Capabilities](/architecture/endpoint-backed-capabilities/): every capability is an endpoint first.

## Access and assistants

- [Access Control](/architecture/access-control/): principals, permissions and scoped grants.
- [Zelavis Auth](/architecture/auth/): accounts, sessions and sign-in methods per runtime, transactional guarantees, and limits.
- [Assistant Runtime](/architecture/assistant-runtime/): the Admin Agent, its tools and its limits.

## Dashboard

- [Mobile-Slot-Ready Dashboard](/architecture/mobile-slot-ready-dashboard/)
