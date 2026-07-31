---
title: Runtime Targets
---
Zelavis is designed to run as a self-hosted platform on infrastructure the
operator controls.

## Supported runtime targets

Current Zelavis runtime targets:

- Node.js
- Bun

Planned runtime target:

- Deno

The core runtime should continue to use universal JavaScript and standard Web
APIs where practical. Runtime-specific behavior belongs in adapters, and the
supported adapters should serve self-hosted operation rather than reshape
Zelavis around external deployment-provider constraints.

## Not runtime targets

Serverless function hosts and edge-function platforms are not Zelavis runtime
targets.

Zelavis can still integrate with managed providers through plugins. For example,
a plugin may deploy a user website to an external static host, sync files to
object storage, configure DNS, or use an email provider. Those providers are
optional capabilities selected by the user, not the place where the Zelavis
runtime itself is expected to live.

## Hosting model

Zelavis should be able to host websites itself from the local runtime. External
deployment providers are optional targets for user projects when local hosting
is not the desired choice.

The default product story is therefore:

- run Zelavis on a VPS, dedicated server, local machine, container, or future
  Deno-compatible host
- use local database, files, website hosting, dashboard, and service activation
  by default
- opt into provider plugins only when the operator chooses them
