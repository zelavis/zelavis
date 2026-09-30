---
title: Execution Backends and Traffic
description: How Project workloads run, how traffic reaches them, and where Docker and Kubernetes fit.
---

Three questions are easy to blur, and Zelavis keeps them apart: **what runs the
workload** (an execution backend), **who decides where it runs** (the
[Fabric](./fabric.md)), and **how traffic gets to it** ([Edge](./edge.md)).

## Execution backends

A Project runs through a backend that an Agent executes locally. Backends declare
what they can do and Zelavis matches that against what a recipe requires
(`zelavis.project.isolation`). A backend is never a competing scheduler.

| Backend | State |
|---|---|
| Native process | Shipped. The default for development and small hosts. Trusted code, operational isolation only, not a security sandbox. |
| Docker | Contract and detection exist. There is no Project driver yet. |
| Podman, Incus, nspawn, microVM (Firecracker) | Planned. Each is its own backend behind the same contract. |

All backends live behind `packages/zelavis/src/backends`, not as special cases in
the Platform or the Node adapter. Signed authority, leases, audit and reconciliation
belong to the shared Agent, never to a per-backend command runner.

## Native recipes and container recipes

The plan is two ways to build a recipe, over one contract:

- A **native recipe** ships a runtime that provisions and supervises processes
  itself (see [Recipe Runtimes](./recipe-runtimes.md)). It is fast, needs no
  container daemon and works on a laptop. The cost is that someone maintains the
  provisioning code for each app. This suits a few flagship apps.
- A **container recipe** would name an image (by digest), ports, volumes and
  environment, and be run by the Docker backend. Most third-party apps already
  publish maintained images, so a recipe becomes a small manifest. The backend
  would enforce the safety rules (no privileged mode, no host networking, no
  socket mounts, pinned digests) once, for every recipe.

Both would look identical to the dashboard, the marketplace and the allow-list,
which could pin image digests the way it pins npm integrity. Container recipes are
a plan, not a shipped feature.

## Kubernetes and Swarm

Zelavis does not use either as its core. The Fabric already is the scheduler and
placement authority, and a second scheduler underneath would decide the same
question twice. Kubernetes could later be one more backend, treated as capacity
the Fabric places onto, for installations that already run a cluster. Swarm has
no role.

## Traffic: Edge and its proxies

Ingress is the [Edge](./edge.md) control plane. The reverse proxy is a replaceable
adapter that receives compiled output, never the source of truth.

- **Traefik** is the shipped adapter. Placement changes routes constantly, and
  Traefik reloads dynamic configuration without dropping traffic and has health
  checks, weighted balancing, TCP/UDP entrypoints and metrics. Zelavis compiles
  its canonical routes to Traefik's dynamic configuration.
- **Caddy** is a good candidate for a lighter adapter on small installs. It exists
  today only as a conformance fixture proving the Edge contract fits a second
  proxy. Certificates are managed by Zelavis's own controller, so Caddy's
  built-in automatic TLS is not needed.
- **Inside a Project**, the WordPress recipe runs its own nginx and PHP-FPM on a
  private port. That is the application's web server. It is a different job from
  Edge and is not exposed publicly.
- **In development** (`pnpm dev`) there is no proxy: the runtime serves the
  dashboard and API directly.
